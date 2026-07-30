/**
 * pocketmoney.gs — Google Apps Script backend for pocketmoney.html.
 *
 * WHAT IT DOES
 * A tiny virtual-allowance ledger stored in a Google Sheet. Kids open the web
 * page, see their remaining balance, and record what they spent (a debit, with
 * a short note). The parent, protected by a PIN, adds money (a credit). Kids
 * can only ever deduct: crediting requires the ADMIN_PIN and is enforced here
 * on the server, so it can't be bypassed from the page's source.
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
 * Then, for either option:
 *   4. Project Settings → Script properties → add
 *          ADMIN_PIN = <a PIN only you, the parent, know>   (e.g. 4629)
 *   5. Deploy → New deployment → type "Web app".
 *          Execute as:     Me
 *          Who has access: Anyone
 *      Copy the resulting "/exec" Web app URL.
 *   6. In static-raw/pocketmoney.html set:
 *          const WEB_APP_URL = '<the /exec URL from step 5>';
 *      and edit ACCOUNTS / SHEET_NAME to match. Commit & deploy the site.
 *
 * NOTES
 * - After changing this script you must redeploy (Deploy → Manage deployments →
 *   edit → new version) for the /exec URL to serve the new code.
 * - The page sends requests as text/plain to avoid a CORS preflight, same as
 *   the expenses form.
 */

var SHEET_NAME = 'PocketMoney';
var HEADERS = ['Timestamp', 'Date', 'Account', 'Type', 'Amount', 'Note', 'By'];
var VERSION = '1.0';

// ── HTTP endpoints (called by the page) ──────────────────────────────────────

function doGet(e) {
  try {
    var name = (e && e.parameter && e.parameter.sheet) || SHEET_NAME;
    return json_(readState_(getSheet_(name)));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sheet = getSheet_(data.sheet || SHEET_NAME);
    if (data.op === 'expense') {
      return json_(addTxn_(sheet, data, 'expense'));
    }
    if (data.op === 'credit') {
      var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
      if (!expected) return json_({ ok: false, error: 'Server is missing ADMIN_PIN' });
      if (String(data.pin || '') !== String(expected)) {
        return json_({ ok: false, error: 'Wrong PIN' });
      }
      return json_(addTxn_(sheet, data, 'credit'));
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

function addTxn_(sheet, data, type) {
  var account = String(data.account || '').trim();
  if (!account) return { ok: false, error: 'Missing account' };

  var amount = roundMoney_(Number(data.amount));
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount' };

  var note = String(data.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // A kid may only spend what they actually have. Checked under the lock so
    // two quick taps can't both pass against a stale balance.
    if (type === 'expense') {
      var bal = balanceOf_(sheet, account);
      if (amount > bal + 1e-9) return { ok: false, error: 'Not enough balance' };
    }
    var now = new Date();
    var tz = Session.getScriptTimeZone();
    var date = data.date ? String(data.date) : Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    sheet.appendRow([now, date, account, type, amount, note, type === 'credit' ? 'admin' : 'kid']);
    return readState_(sheet);
  } finally {
    lock.releaseLock();
  }
}

// Full state: balances for every account plus the most recent transactions.
function readState_(sheet) {
  var values = sheet.getDataRange().getValues();
  var balances = {};
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    var account = String(r[2] || '');
    if (!account) continue;
    var type = String(r[3] || '');
    var amount = Number(r[4]) || 0;
    balances[account] = (balances[account] || 0) + (type === 'credit' ? amount : -amount);
    rows.push({
      date: fmtDate_(r[1]),
      account: account,
      type: type,
      amount: amount,
      note: String(r[5] || ''),
      by: String(r[6] || ''),
    });
  }
  Object.keys(balances).forEach(function (k) { balances[k] = roundMoney_(balances[k]); });
  rows.reverse(); // appendRow adds at the bottom, so newest is last
  return { ok: true, version: VERSION, balances: balances, rows: rows.slice(0, 50) };
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
