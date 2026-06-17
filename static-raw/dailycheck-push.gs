/**
 * dailycheck-push.gs — Web Push sender for dailycheck.html, on Google Apps Script.
 *
 * WHY THIS EXISTS
 * On iPhone, a Home-Screen web app cannot run in the background, so its badge
 * only refreshes when you open it. The only way to update the badge while the
 * phone is locked and untouched is a Web Push that wakes the service worker.
 * This script sends one payload-less ("tickle") push each morning; the service
 * worker (dailycheck-sw.js) then recomputes today's badge and shows a
 * notification.
 *
 * It stores push subscriptions (POSTed by the page) in Script Properties and,
 * on a daily time trigger, signs a VAPID (ES256) JWT and POSTs an empty body to
 * each subscription's push endpoint. Empty body => no RFC 8291 payload
 * encryption needed (which Apps Script can't do natively); we only need the
 * VAPID signature, done here with the jsrsasign library.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SETUP (one time)
 *
 * 1. Generate a VAPID key pair (on any machine with Node):
 *        npx web-push generate-vapid-keys
 *    It prints a Public Key and Private Key (both base64url strings).
 *
 * 2. Create a new Apps Script project at https://script.google.com →
 *    paste this whole file into Code.gs (replace the default contents).
 *
 * 3. Project Settings (gear icon) → Script properties → add three:
 *        VAPID_PUBLIC    = <the public key from step 1>
 *        VAPID_PRIVATE   = <the private key from step 1>
 *        VAPID_SUBJECT   = mailto:you@example.com   (your contact, required)
 *
 * 4. Deploy → New deployment → type "Web app".
 *        Execute as:    Me
 *        Who has access: Anyone
 *    Copy the resulting "/exec" Web app URL.
 *
 * 5. In static-raw/dailycheck.html set the two constants near the top:
 *        const VAPID_PUBLIC_KEY = '<the public key from step 1>';
 *        const PUSH_API_URL     = '<the /exec URL from step 4>';
 *    Commit & deploy the site.
 *
 * 6. On your iPhone, open the installed web app, tap "Enable home-screen badge"
 *    and allow notifications. That registers this device with the server.
 *
 * 7. Back in Apps Script, run sendTestPush() once. Approve the permission
 *    prompt (it needs "Connect to an external service"). Your phone should get
 *    a "Daily Tracker" notification and the badge should update.
 *
 * 8. Triggers (clock icon) → Add Trigger:
 *        Function:        sendDailyPush
 *        Event source:    Time-driven
 *        Type:            Day timer
 *        Time of day:     e.g. 6am–7am
 *    Set the project's time zone in Project Settings so "morning" is your
 *    morning.
 *
 * NOTES
 * - Subscriptions live in Script Properties (a few hundred bytes each; fine for
 *   a handful of personal devices). Dead endpoints (404/410) are auto-removed.
 * - jsrsasign reaches end-of-support 2026-06-03 but still works; it is pinned
 *   to a fixed version below so the import stays stable.
 */

// jsrsasign needs these globals to exist before it loads.
var navigator = {};
var window = {};
var JSRSASIGN_URL = 'https://cdn.jsdelivr.net/npm/jsrsasign@11.1.0/lib/jsrsasign-all-min.js';
// Top-level eval makes KJUR / KEYUTIL available as globals (the documented
// Apps Script pattern). It runs once per execution.
eval(UrlFetchApp.fetch(JSRSASIGN_URL).getContentText());

var SUBS_PROP = 'subs';

// ── HTTP endpoints (called by the page) ────────────────────────────────────

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.type === 'subscribe') {
      saveSub_(data.subscription);
      return json_({ ok: true });
    }
    if (data.type === 'unsubscribe') {
      removeSub_(data.subscription && data.subscription.endpoint);
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'unknown type' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, subscribers: getSubs_().length });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Subscription storage ────────────────────────────────────────────────────

function getSubs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(SUBS_PROP);
  return raw ? JSON.parse(raw) : [];
}

function setSubs_(arr) {
  PropertiesService.getScriptProperties().setProperty(SUBS_PROP, JSON.stringify(arr));
}

function saveSub_(sub) {
  if (!sub || !sub.endpoint) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var subs = getSubs_().filter(function (s) { return s.endpoint !== sub.endpoint; });
    subs.push(sub);
    setSubs_(subs);
  } finally {
    lock.releaseLock();
  }
}

function removeSub_(endpoint) {
  if (!endpoint) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    setSubs_(getSubs_().filter(function (s) { return s.endpoint !== endpoint; }));
  } finally {
    lock.releaseLock();
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────

function sendDailyPush() {
  var subs = getSubs_();
  var dead = [];
  for (var i = 0; i < subs.length; i++) {
    try {
      var code = sendOne_(subs[i]);
      if (code === 404 || code === 410) dead.push(subs[i].endpoint);
    } catch (err) {
      Logger.log('push error: ' + err);
    }
  }
  dead.forEach(removeSub_);
  Logger.log('sent to ' + (subs.length - dead.length) + ' subscriber(s), removed ' + dead.length);
}

// Convenience: run from the editor to test against all stored subscriptions.
function sendTestPush() {
  sendDailyPush();
}

function sendOne_(sub) {
  var endpoint = sub.endpoint;
  var aud = endpoint.match(/^https?:\/\/[^\/]+/)[0];
  var jwt = vapidJwt_(aud);
  var pub = PropertiesService.getScriptProperties().getProperty('VAPID_PUBLIC');

  // Payload-less push: empty body, no Content-Encoding header.
  var res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    headers: {
      'Authorization': 'vapid t=' + jwt + ', k=' + pub,
      'TTL': '86400',
      'Urgency': 'normal',
    },
    contentLength: 0,
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 400) Logger.log('endpoint ' + code + ': ' + res.getContentText());
  return code;
}

// ── VAPID (RFC 8292): ES256-signed JWT identifying this server ───────────────

function vapidJwt_(aud) {
  var props = PropertiesService.getScriptProperties();
  var subject = props.getProperty('VAPID_SUBJECT');
  var header = { typ: 'JWT', alg: 'ES256' };
  var now = Math.floor(Date.now() / 1000);
  var payload = {
    aud: aud,
    exp: now + 12 * 60 * 60, // must be < 24h ahead
    sub: subject,
  };
  var key = KEYUTIL.getKey(vapidJwk_());
  return KJUR.jws.JWS.sign('ES256', JSON.stringify(header), JSON.stringify(payload), key);
}

// Build a P-256 JWK from the base64url VAPID keys so jsrsasign can load it.
function vapidJwk_() {
  var props = PropertiesService.getScriptProperties();
  var pubBytes = b64urlDecode_(props.getProperty('VAPID_PUBLIC')); // 0x04 || X(32) || Y(32)
  var x = pubBytes.slice(1, 33);
  var y = pubBytes.slice(33, 65);
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode_(x),
    y: b64urlEncode_(y),
    d: normalizeB64url_(props.getProperty('VAPID_PRIVATE')),
  };
}

// ── base64url helpers (Apps Script Utilities use standard base64) ────────────

function b64urlDecode_(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Utilities.base64Decode(s);
}

function b64urlEncode_(bytes) {
  return Utilities.base64Encode(bytes)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizeB64url_(s) {
  return String(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
