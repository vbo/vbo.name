/**
 * pocketmoney.gs — Google Apps Script backend for pocketmoney.html.
 *
 * WHAT IT DOES
 * A tiny virtual-allowance ledger stored in a Google Sheet. Each kid opens the
 * web page through their own private link and sees only their own remaining
 * balance, and can record what they spent (a debit, with a short note). The
 * parent, protected by a PIN, adds money (a credit) to any account.
 *
 * PRIVACY / WHO-CAN-DO-WHAT (all enforced here on the server)
 *   - Each kid has a secret key. A kid's link is  …/pocketmoney.html?k=<key>.
 *     A request carrying a key can only read and spend THAT key's account —
 *     one sibling can never see or charge another sibling's account, even by
 *     editing the URL, because the key→account map lives only on the server
 *     (Script Properties) and never in the public HTML.
 *   - Only the parent, by supplying the ADMIN_PIN, can add money or view all
 *     balances at once. Kids can only ever deduct, and never below zero. The
 *     parent (with the PIN) can also "charge" an account below zero to record
 *     a loan; that debt is repaid by later credits.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORTANT — this file defines NO doGet / doPost and NO plain global names.
 * Everything is prefixed pm* / PM_ so it can live in the SAME Apps Script
 * project as another web app (e.g. your expenses tracker) without clashing.
 * A project may only have one doGet and one doPost, so you wire this module in
 * from whatever doGet/doPost the project already has. See INTEGRATION below.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * DATA MODEL
 * One tab (default "PocketMoney") in the spreadsheet, one row per transaction:
 *
 *   Timestamp | Date | Account | Type | Amount | Note | By
 *
 *   - Type is "credit" (parent adds) or "expense" (kid spends).
 *   - Amount is always a positive number (CHF).
 *   - Balance for an account = sum(credit) - sum(expense).
 *
 * The tab (with this header row) is created automatically on first use.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP (one time)
 *
 * 1. Script properties (Project Settings → Script properties):
 *      ADMIN_PIN = <a PIN only you, the parent, know>            (e.g. 4629)
 *      KID_KEYS  = <JSON mapping each account (the name shown in the app) to its
 *      secret key>, e.g.
 *          {"Eva":"7fk2-eva","Martin":"9mq4-martin"}
 *      Pick keys that are hard to guess and keep them secret from each other.
 *      (Optional) SPREADSHEET_ID = <id> if this project is NOT bound to the
 *      spreadsheet you want; leave unset to use the bound/active spreadsheet.
 *
 * 2. Paste this whole file into the project as its own file (e.g.
 *    PocketMoney.gs). Then hook it into the project's HTTP entry points —
 *    pick ONE of the two options below.
 *
 * ── INTEGRATION A: SAME project as the expenses tracker (your setup) ──
 * The expenses script already owns doGet/doPost. Add one line at the TOP of
 * each so pocket-money traffic is handed off before the expenses logic runs.
 * Pocket-money requests are recognised by a `k` query param (GET) or an `op`
 * field in the JSON body (POST); expenses requests have neither, so they fall
 * through untouched.
 *
 *   function doGet(e) {
 *     if (e && e.parameter && e.parameter.k) return pmDoGet(e);   // ← add
 *     ...your existing expenses doGet code...
 *   }
 *
 *   function doPost(e) {
 *     var data = JSON.parse(e.postData.contents);
 *     if (data && data.op) return pmDoPost(e);                    // ← add
 *     ...your existing expenses doPost code (it can reuse `data`)...
 *   }
 *
 * ── INTEGRATION B: standalone project (pocket money only) ──
 * There is no other doGet/doPost, so add these two thin wrappers once:
 *
 *   function doGet(e)  { return pmDoGet(e); }
 *   function doPost(e) { return pmDoPost(e); }
 *
 * 3. Deploy → Manage deployments → edit → New version (redeploy so the /exec
 *    URL serves the new code). Access: "Anyone". Copy the /exec URL.
 * 4. In static-raw/pocketmoney.html set  const WEB_APP_URL = '<that /exec URL>';
 *    (If sharing with expenses, it's the SAME /exec URL.) Give each kid their
 *    link …/pocketmoney.html?k=<their key> for their Home Screen; you, the
 *    parent, open the plain …/pocketmoney.html and use the PIN panel.
 *
 * NOTE: the page sends requests as text/plain to avoid a CORS preflight.
 */

var PM_SHEET_NAME = 'PocketMoney';
var PM_HEADERS = ['Timestamp', 'Date', 'Account', 'Type', 'Amount', 'Note', 'By'];
var PM_VERSION = '1.6';

// ── HTTP entry points (called from the project's doGet/doPost) ───────────────

// A kid loading their own balance:  GET ...?k=<key>
function pmDoGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var sheet = pmGetSheet_(p.sheet || PM_SHEET_NAME);
    var key = p.k || p.key;
    if (!key) return pmJson_({ ok: false, error: 'Missing link' });
    var account = pmAccountForKey_(String(key));
    if (!account) return pmJson_({ ok: false, error: 'Unknown link' });
    return pmJson_(pmKidState_(sheet, account));
  } catch (err) {
    return pmJson_({ ok: false, error: String(err) });
  }
}

function pmDoPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = pmGetSheet_(data.sheet || PM_SHEET_NAME);

    // Kid spends: authorised purely by their secret key → resolves to exactly
    // one account. No key means no spending.
    if (data.op === 'expense') {
      var account = pmAccountForKey_(String(data.key || ''));
      if (!account) return pmJson_({ ok: false, error: 'Unknown link' });
      return pmJson_(pmAddExpense_(sheet, account, data));
    }

    // Parent-only operations require the admin PIN.
    if (data.op === 'credit' || data.op === 'charge' || data.op === 'overview') {
      var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
      if (!expected) return pmJson_({ ok: false, error: 'Server is missing ADMIN_PIN' });
      if (String(data.pin || '') !== String(expected)) {
        return pmJson_({ ok: false, error: 'Wrong PIN' });
      }
      if (data.op === 'overview') return pmJson_(pmAdminState_(sheet));
      // A parent-authorised charge is a debit that may take the balance below
      // zero (a loan). Kids' own expenses can never overdraw — see pmDoPost's
      // expense path — but the parent, with the PIN, can.
      if (data.op === 'charge') return pmJson_(pmAddCharge_(sheet, data));
      return pmJson_(pmAddCredit_(sheet, data));
    }

    return pmJson_({ ok: false, error: 'Unknown op' });
  } catch (err) {
    return pmJson_({ ok: false, error: String(err) });
  }
}

function pmJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Ledger operations ─────────────────────────────────────────────────────────

function pmAddExpense_(sheet, account, data) {
  var amount = pmRoundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // A kid may only spend what they actually have. Checked under the lock so
    // two quick taps can't both pass against a stale balance.
    var bal = pmBalanceOf_(sheet, account);
    if (amount > bal + 1e-9) return { ok: false, error: 'Not enough balance' };
    pmAppendRow_(sheet, account, 'expense', amount, note, 'kid');
    return pmKidState_(sheet, account);
  } finally {
    lock.releaseLock();
  }
}

function pmAddCredit_(sheet, data) {
  var account = String(data.account || '').trim();
  if (!account) return { ok: false, error: 'Missing account' };
  // Only known accounts can be credited.
  if (!pmAccounts_()[account]) return { ok: false, error: 'Unknown account' };
  var amount = pmRoundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    pmAppendRow_(sheet, account, 'credit', amount, note, 'admin');
    return pmAdminState_(sheet);
  } finally {
    lock.releaseLock();
  }
}

// Parent-authorised debit that is allowed to push the balance negative (loan).
function pmAddCharge_(sheet, data) {
  var account = String(data.account || '').trim();
  if (!account) return { ok: false, error: 'Missing account' };
  if (!pmAccounts_()[account]) return { ok: false, error: 'Unknown account' };
  var amount = pmRoundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // No balance check on purpose: this is the parent loaning money.
    pmAppendRow_(sheet, account, 'expense', amount, note, 'admin');
    return pmAdminState_(sheet);
  } finally {
    lock.releaseLock();
  }
}

function pmAppendRow_(sheet, account, type, amount, note, by) {
  var now = new Date();
  var date = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([now, date, account, type, amount, note, by]);
}

// ── State readers ─────────────────────────────────────────────────────────────

// What a single kid is allowed to see: only their own account.
function pmKidState_(sheet, account) {
  var values = sheet.getDataRange().getValues();
  var balance = 0;
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][2]) !== account) continue;
    var row = pmReadRow_(values[i]);
    balance += row.type === 'credit' ? row.amount : -row.amount;
    rows.push(row);
  }
  rows.reverse(); // newest first
  return {
    ok: true,
    version: PM_VERSION,
    account: account,
    balance: pmRoundMoney_(balance),
    rows: rows.slice(0, 50),
  };
}

// What the parent sees: every account's balance plus recent activity.
function pmAdminState_(sheet) {
  var values = sheet.getDataRange().getValues();
  var balances = {};
  // Seed with configured accounts so brand-new ones show a 0 balance.
  Object.keys(pmAccounts_()).forEach(function (a) { balances[a] = 0; });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var account = String(values[i][2] || '');
    if (!account) continue;
    var row = pmReadRow_(values[i]);
    balances[account] = (balances[account] || 0) + (row.type === 'credit' ? row.amount : -row.amount);
    rows.push(row);
  }
  Object.keys(balances).forEach(function (k) { balances[k] = pmRoundMoney_(balances[k]); });
  rows.reverse();
  return {
    ok: true,
    version: PM_VERSION,
    balances: balances,
    accounts: Object.keys(balances),
    // The secret keys, so the parent can copy each kid's private link. This is
    // only ever returned on a PIN-authenticated response (overview/credit/
    // charge) — kids' own responses (pmKidState_) never include keys.
    keys: pmAccounts_(),
    rows: rows.slice(0, 50),
  };
}

function pmBalanceOf_(sheet, account) {
  var values = sheet.getDataRange().getValues();
  var bal = 0;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][2]) !== account) continue;
    var amount = Number(values[i][4]) || 0;
    bal += String(values[i][3]) === 'credit' ? amount : -amount;
  }
  return pmRoundMoney_(bal);
}

function pmReadRow_(r) {
  return {
    date: pmFmtDate_(r[1]),
    account: String(r[2] || ''),
    type: String(r[3] || ''),
    amount: Number(r[4]) || 0,
    note: String(r[5] || ''),
    by: String(r[6] || ''),
  };
}

// ── Keys / config ─────────────────────────────────────────────────────────────

// Parsed KID_KEYS → { account: secretKey, ... }. The account name is the name
// shown in the app.
function pmAccounts_() {
  var raw = PropertiesService.getScriptProperties().getProperty('KID_KEYS');
  if (!raw) return {};
  try {
    var obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    return {};
  }
}

function pmAccountForKey_(key) {
  if (!key) return null;
  var accounts = pmAccounts_();
  var names = Object.keys(accounts);
  for (var i = 0; i < names.length; i++) {
    if (String(accounts[names[i]]) === key) return names[i];
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pmGetSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function pmGetSheet_(name) {
  var ss = pmGetSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(PM_HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(PM_HEADERS);
  }
  return sheet;
}

function pmRoundMoney_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// A Date cell serializes to yyyy-MM-dd; a text cell is kept as-is (prefix only).
function pmFmtDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var m = String(v == null ? '' : v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : String(v == null ? '' : v);
}
