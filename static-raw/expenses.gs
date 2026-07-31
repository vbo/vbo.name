/**
 * expenses.gs — Google Apps Script backend for expenses.html.
 *
 * Lives in the SAME Apps Script project as pocketmoney.gs and idempotency.gs.
 * This file owns doGet/doPost; pocket-money traffic is delegated first.
 *
 * DEPLOY
 * 1. Paste this file + pocketmoney.gs + idempotency.gs into the project.
 * 2. Deploy → Manage deployments → New version → Anyone.
 * 3. expenses.html and pocketmoney.html both use the same /exec URL.
 *
 * IDEMPOTENCY
 * expenses.html sends a stable requestId per save and retries on transient
 * failures. idempotency.gs caches successful responses so a retry after a
 * timeout does not append a second row.
 */

const VERSION = 'v4.1-idempotent';
const SHEETS = {
  Common:   { cols: 6, currencies: ['CHF', 'EUR', 'USD', 'RUB', 'AFN'] },
  Personal: { cols: 5, currencies: ['CHF', 'EUR', 'USD', 'RUB'] },
};
const CATEGORIES = new Set([
  'Kleidung: Leben', 'Überweisen', 'Andere: Zuhause', 'Sport: Unterhaltung',
  'Lebensmittel: Essen', 'Verkehrsmittel', 'Auswärts: Essen', 'Geschenke: Leben',
  'Haushaltwaren: Zuhause', 'Spielzeuge: Unterhaltung',
  'Breitband: Versorgungsunternehmen', 'Elektronik: Zuhause',
  'Betreuung: Leben', 'Miete: Zuhause', 'Andere: Unterhaltung',
  'Medizinisch: Leben', 'Andere: Leben',
]);

function doGet(e) {
  if (e && e.parameter && e.parameter.k) return pmDoGet(e);
  const name = (e && e.parameter && e.parameter.sheet) || 'Common';
  const cfg = SHEETS[name];
  if (!cfg) return jsonOut({ ok: false, version: VERSION, error: 'unknown sheet: ' + name });
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) return jsonOut({ ok: false, version: VERSION, error: 'missing tab: ' + name });

  const lastRow = sheet.getLastRow();
  const headerRows = 1;
  const n = Math.min(10, Math.max(0, lastRow - headerRows));
  let rows = [];
  if (n > 0) {
    rows = sheet.getRange(lastRow - n + 1, 1, n, cfg.cols).getValues().map(function (r) {
      const o = { date: r[0], amount: r[1], note: r[2], category: r[3], currency: r[4] };
      if (cfg.cols === 6) o.paidBy = r[5];
      return o;
    }).reverse();
  }
  return jsonOut({ ok: true, version: VERSION, sheet: name, rows: rows });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data && data.op) return pmDoPost(e);
    if (data && data.requestId) {
      return idemJson_(idemRun_(String(data.requestId), function () {
        return expenseWrite_(data);
      }));
    }
    return jsonOut(expenseWrite_(data));
  } catch (err) {
    return jsonOut({ ok: false, version: VERSION, stage: 'exception', error: String(err) });
  }
}

/** Append one expense row. Returns a plain object (not a ContentService output). */
function expenseWrite_(data) {
  const name = data.sheet || 'Common';
  const cfg = SHEETS[name];
  if (!cfg) return { ok: false, version: VERSION, error: 'unknown sheet: ' + name };
  if (!CATEGORIES.has(data.category)) {
    return { ok: false, version: VERSION, error: 'unknown category: ' + data.category };
  }
  if (cfg.currencies.indexOf(data.currency) === -1) {
    return { ok: false, version: VERSION, error: 'unknown currency for ' + name + ': ' + data.currency };
  }
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) return { ok: false, version: VERSION, stage: 'getSheetByName', wanted: name };
  const row = cfg.cols === 6
    ? [data.date, data.amount, data.note, data.category, data.currency, data.paidBy]
    : [data.date, data.amount, data.note, data.category, data.currency];
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return { ok: true, version: VERSION, wrote: row, sheet: name };
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
