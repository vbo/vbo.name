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
 *     editing the URL, because the key→account map lives only in the server
 *     (Script Properties) and never in the public HTML.
 *   - Only the parent, by supplying the ADMIN_PIN, can add money or view all
 *     balances at once. Kids can only ever deduct.
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
 * ───────────────────────────────────────────────────────────────────────────
 * SETUP (one time)
 *
 * Option A — put it in the SAME spreadsheet you already use for expenses
 * (recommended, so everything lives in one file):
 *   1. Open that spreadsheet → Extensions → Apps Script.
 *   2. Paste this whole file into a file (e.g. Code.gs).
 *   3. Leave SPREADSHEET_ID unset — getActiveSpreadsheet() finds the bound one.
 *
 * Option B — standalone script pointing at an existing spreadsheet:
 *   1. Create a new project at https://script.google.com and paste this in.
 *   2. Project Settings (gear) → Script properties → add
 *          SPREADSHEET_ID = <the id from the spreadsheet's URL>
 *
 * Then, for either option, add these Script properties
 * (Project Settings → Script properties):
 *   3. ADMIN_PIN = <a PIN only you, the parent, know>            (e.g. 4629)
 *   4. KID_KEYS  = <a JSON object mapping each account to its secret key>, e.g.
 *          {"Daughter":"7fk2-daughter","Son":"9mq4-son"}
 *      Pick keys that are hard to guess. Each kid gets their own; keep them
 *      secret from each other. These are the only place the key→name mapping
 *      lives — it is never shipped to the browser.
 *   5. Deploy → New deployment → type "Web app".
 *          Execute as:     Me
 *          Who has access: Anyone
 *      Copy the resulting "/exec" Web app URL.
 *   6. In static-raw/pocketmoney.html set
 *          const WEB_APP_URL = '<the /exec URL from step 5>';
 *      then give each kid their personal link, e.g.
 *          https://…/pocketmoney.html?k=7fk2-daughter
 *      (add it to their phone's Home Screen). You, the parent, open the plain
 *      https://…/pocketmoney.html and use the PIN-protected Parent panel.
 *
 * NOTES
 * - After changing this script you must redeploy (Deploy → Manage deployments →
 *   edit → new version) for the /exec URL to serve the new code.
 * - The page sends requests as text/plain to avoid a CORS preflight, same as
 *   the expenses form.
 */

var SHEET_NAME = 'PocketMoney';
var HEADERS = ['Timestamp', 'Date', 'Account', 'Type', 'Amount', 'Note', 'By'];
var VERSION = '1.1';

// ── HTTP endpoints (called by the page) ──────────────────────────────────────

// A kid loading their own balance:  GET ...?k=<key>
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var sheet = getSheet_(p.sheet || SHEET_NAME);
    var key = p.k || p.key;
    if (!key) return json_({ ok: false, error: 'Missing link' });
    var account = accountForKey_(String(key));
    if (!account) return json_({ ok: false, error: 'Unknown link' });
    return json_(kidState_(sheet, account));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getSheet_(data.sheet || SHEET_NAME);

    // Kid spends: authorised purely by their secret key → resolves to exactly
    // one account. No key means no spending.
    if (data.op === 'expense') {
      var account = accountForKey_(String(data.key || ''));
      if (!account) return json_({ ok: false, error: 'Unknown link' });
      return json_(addExpense_(sheet, account, data));
    }

    // Parent-only operations require the admin PIN.
    if (data.op === 'credit' || data.op === 'overview') {
      var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
      if (!expected) return json_({ ok: false, error: 'Server is missing ADMIN_PIN' });
      if (String(data.pin || '') !== String(expected)) {
        return json_({ ok: false, error: 'Wrong PIN' });
      }
      if (data.op === 'overview') return json_(adminState_(sheet));
      return json_(addCredit_(sheet, data));
    }

    return json_({ ok: false, error: 'Unknown op' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Ledger operations ─────────────────────────────────────────────────────────

function addExpense_(sheet, account, data) {
  var amount = roundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // A kid may only spend what they actually have. Checked under the lock so
    // two quick taps can't both pass against a stale balance.
    var bal = balanceOf_(sheet, account);
    if (amount > bal + 1e-9) return { ok: false, error: 'Not enough balance' };
    appendRow_(sheet, account, 'expense', amount, note, 'kid');
    return kidState_(sheet, account);
  } finally {
    lock.releaseLock();
  }
}

function addCredit_(sheet, data) {
  var account = String(data.account || '').trim();
  if (!account) return { ok: false, error: 'Missing account' };
  // Only known accounts can be credited.
  if (!accountKeys_()[account]) return { ok: false, error: 'Unknown account' };
  var amount = roundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };
  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendRow_(sheet, account, 'credit', amount, note, 'admin');
    return adminState_(sheet);
  } finally {
    lock.releaseLock();
  }
}

function appendRow_(sheet, account, type, amount, note, by) {
  var now = new Date();
  var date = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([now, date, account, type, amount, note, by]);
}

// ── State readers ─────────────────────────────────────────────────────────────

// What a single kid is allowed to see: only their own account.
function kidState_(sheet, account) {
  var values = sheet.getDataRange().getValues();
  var balance = 0;
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][2]) !== account) continue;
    var row = readRow_(values[i]);
    balance += row.type === 'credit' ? row.amount : -row.amount;
    rows.push(row);
  }
  rows.reverse(); // newest first
  return {
    ok: true,
    version: VERSION,
    account: account,
    balance: roundMoney_(balance),
    rows: rows.slice(0, 50),
  };
}

// What the parent sees: every account's balance plus recent activity.
function adminState_(sheet) {
  var values = sheet.getDataRange().getValues();
  var balances = {};
  // Seed with configured accounts so brand-new ones show a 0 balance.
  Object.keys(accountKeys_()).forEach(function (a) { balances[a] = 0; });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var account = String(values[i][2] || '');
    if (!account) continue;
    var row = readRow_(values[i]);
    balances[account] = (balances[account] || 0) + (row.type === 'credit' ? row.amount : -row.amount);
    rows.push(row);
  }
  Object.keys(balances).forEach(function (k) { balances[k] = roundMoney_(balances[k]); });
  rows.reverse();
  return {
    ok: true,
    version: VERSION,
    balances: balances,
    accounts: Object.keys(balances),
    rows: rows.slice(0, 50),
  };
}

function balanceOf_(sheet, account) {
  var values = sheet.getDataRange().getValues();
  var bal = 0;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][2]) !== account) continue;
    var amount = Number(values[i][4]) || 0;
    bal += String(values[i][3]) === 'credit' ? amount : -amount;
  }
  return roundMoney_(bal);
}

function readRow_(r) {
  return {
    date: fmtDate_(r[1]),
    account: String(r[2] || ''),
    type: String(r[3] || ''),
    amount: Number(r[4]) || 0,
    note: String(r[5] || ''),
    by: String(r[6] || ''),
  };
}

// ── Keys / config ─────────────────────────────────────────────────────────────

// Parsed KID_KEYS: { accountName: secretKey, ... }.
function accountKeys_() {
  var raw = PropertiesService.getScriptProperties().getProperty('KID_KEYS');
  if (!raw) return {};
  try {
    var obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    return {};
  }
}

function accountForKey_(key) {
  if (!key) return null;
  var map = accountKeys_();
  var names = Object.keys(map);
  for (var i = 0; i < names.length; i++) {
    if (String(map[names[i]]) === key) return names[i];
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
  }
  return sheet;
}

function roundMoney_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// A Date cell serializes to yyyy-MM-dd; a text cell is kept as-is (prefix only).
function fmtDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var m = String(v == null ? '' : v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : String(v == null ? '' : v);
}
