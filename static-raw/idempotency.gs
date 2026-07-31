/**
 * idempotency.gs — safe retries for Google Apps Script web-app writes.
 *
 * PROBLEM
 * A save can succeed on the server but the phone never gets the response
 * (timeout, flaky network). Retrying then appends a second row — double entry.
 *
 * FIX
 * The client sends a unique `requestId` (UUID) with every mutation and reuses
 * the SAME id on automatic retries. The server remembers successful responses
 * keyed by that id and returns the cached result instead of writing again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRED IN expenses.gs (same Apps Script project)
 *
 * expenses.gs doPost delegates to idemRun_ when the client sends requestId
 * (expenses.html does this on every save). Pocket money uses its own RequestId
 * column on the PocketMoney sheet via pocketmoney.gs.
 *
 * Paste this file into the project alongside expenses.gs and pocketmoney.gs,
 * then redeploy a new web-app version.
 *
 * STORAGE
 * A hidden sheet tab `_Idempotency` stores RequestId | ResponseJson | CreatedAt.
 * Expense rows on Common/Personal do NOT get a RequestId column — look on this tab.
 * Old rows can be deleted manually once in a while; they are tiny.
 */

var IDEM_SHEET = '_Idempotency';
var IDEM_HEADERS = ['RequestId', 'ResponseJson', 'CreatedAt'];

function idemJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function idemGetSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(IDEM_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(IDEM_SHEET);
    try { sheet.hideSheet(); } catch (_) { /* hide not always allowed */ }
    if (sheet.getLastRow() === 0) sheet.appendRow(IDEM_HEADERS);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(IDEM_HEADERS);
  }
  return sheet;
}

function idemLookup_(requestId) {
  var sheet = idemGetSheet_();
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === requestId) {
      try { return JSON.parse(String(values[i][1])); } catch (_) { return null; }
    }
  }
  return null;
}

function idemStore_(requestId, response) {
  idemGetSheet_().appendRow([requestId, JSON.stringify(response), new Date()]);
}

/**
 * Run `fn` once per requestId. Concurrent duplicate requests block on the script
 * lock; the second caller gets the cached response from the first.
 * Only successful responses (`ok === true`) are stored.
 */
function idemRun_(requestId, fn) {
  if (!requestId) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var cached = idemLookup_(requestId);
    if (cached) {
      var replay = JSON.parse(JSON.stringify(cached));
      replay.deduped = true;
      return replay;
    }
    var result = fn();
    if (result && result.ok === true) {
      result.deduped = false;
      idemStore_(requestId, result);
      SpreadsheetApp.flush();
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}
