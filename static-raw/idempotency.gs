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
 * USE IN THE EXPENSES doPost (same Apps Script project)
 *
 * At the top of your existing expenses doPost, after parsing `data`:
 *
 *   function doPost(e) {
 *     var data = JSON.parse(e.postData.contents);
 *     if (data && data.op) return pmDoPost(e);          // pocket money (already idempotent)
 *     if (data && data.requestId) {
 *       return idemJson_(idemRun_(String(data.requestId), function () {
 *         return yourExistingExpenseWrite_(data);       // must return { ok: true, ... }
 *       }));
 *     }
 *     return yourExistingExpenseWriteResponse_(data);  // legacy clients without requestId
 *   }
 *
 * `yourExistingExpenseWrite_` should be whatever you already do to append the
 * row and return `{ ok: true, version: '...', ... }`. Do not change the payload
 * shape the expenses.html page expects.
 *
 * Also add this file to the project (Extensions → Apps Script → + → paste).
 * Redeploy a new web-app version after adding it.
 *
 * STORAGE
 * A hidden sheet tab `_Idempotency` stores RequestId | ResponseJson | CreatedAt.
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
    if (cached) return cached;
    var result = fn();
    if (result && result.ok === true) {
      idemStore_(requestId, result);
      SpreadsheetApp.flush();
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}
