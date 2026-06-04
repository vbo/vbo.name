#!/usr/bin/env node
'use strict';
// Evolutionary optimizer for startext.html BOT_CONFIG parameters.
// Uses a (1+N) evolution strategy: one champion, N mutations per generation.
// Fitness = win rate of test config vs current champion (both sides, symmetric).
// Run from static-raw/:  node bot-evolve.js [--gen N] [--pop N] [--games N]

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? Number(args[i+1]) : def; };
const GENERATIONS     = argVal('--gen',   12);
const POPULATION      = argVal('--pop',   10);
const GAMES_PER_MATCH = argVal('--games',  5);
const PATCH_BACK      = !args.includes('--no-patch');
const VERBOSE         = args.includes('--verbose');

// ── Load game ────────────────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'startext.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd   = html.indexOf('</script>', scriptStart);
if (scriptStart === -1 || scriptEnd === -1) { console.error('Cannot find <script> block'); process.exit(1); }
const gameScript = html.slice(scriptStart + '<script>'.length, scriptEnd);

// Run the script in a fresh VM context that has no `document`, so the game
// detects HEADLESS=true. We promote the key `let` vars to `var` so they
// become properties of the context (accessible as ctx.*).  `process` is
// intentionally absent from ctx so the HEADLESS process.exit() is a no-op.
const patchedScript = gameScript
  .replace(/^let (state\b)/m,            'var $1')
  .replace(/^let (BOT_CONFIG\b)/m,       'var $1')
  .replace(/^let (HUMAN_CONFIG\b)/m,     'var $1')
  .replace(/^let (ENABLE_HUMAN_BOT\b)/m, 'var $1')
  .replace(/^let (HOME\b)/m,             'var $1')
  .replace(/^let (AWAY\b)/m,             'var $1');
const ctx = { console };
vm.createContext(ctx);
// Suppress test-runner output during load
const _log = console.log; console.log = () => {};
try { vm.runInContext(patchedScript, ctx); } finally { console.log = _log; }

// ── Game references ───────────────────────────────────────────────────────────
const { resetState, tick } = ctx;
if (!resetState || !tick) { console.error('Game globals not found — check script extraction'); process.exit(1); }

// BOT_CONFIG_DEFAULT is `const` — not in ctx. Capture defaults from the var copy.
const DEFAULT_CFG = { ...ctx.BOT_CONFIG };

function runGame(botCfg, humanCfg, seed) {
  // Mutate the config objects in-place — evalSide reads them through closure
  Object.assign(ctx.BOT_CONFIG,   DEFAULT_CFG, botCfg);
  Object.assign(ctx.HUMAN_CONFIG, DEFAULT_CFG, humanCfg);
  ctx.ENABLE_HUMAN_BOT = true;
  resetState(seed);
  const MAX_TICKS = 1500; // ~25 min of game time; ~40% of games decide, rest scored by army
  for (let t = 0; t < MAX_TICKS; t++) {
    tick();
    const s = ctx.state;
    const botCC    = s.buildings.some(b => b.owner === 'bot'   && b.type === 'cc' && !b.construct);
    const humanCC  = s.buildings.some(b => b.owner === 'human' && b.type === 'cc' && !b.construct);
    if (!botCC || !humanCC) return botCC ? 1 : 0;
  }
  // Timeout: score by army size
  const s = ctx.state;
  const botArmy   = s.units.filter(u => u.owner === 'bot'   && (u.type === 'marine' || u.type === 'firebat')).length;
  const humanArmy = s.units.filter(u => u.owner === 'human' && (u.type === 'marine' || u.type === 'firebat')).length;
  return botArmy >= humanArmy ? 1 : 0;
}

// Win rate of testCfg vs refCfg (plays both sides, returns 0–1).
function evaluate(testCfg, refCfg) {
  let wins = 0;
  for (let g = 0; g < GAMES_PER_MATCH; g++) {
    wins += runGame(testCfg, refCfg, g);        // test = bot
    wins += 1 - runGame(refCfg, testCfg, g);    // test = human
  }
  return wins / (2 * GAMES_PER_MATCH);
}

// ── Parameter bounds ─────────────────────────────────────────────────────────
const BOUNDS = {
  scvCapBase:      [6,  20], scvCapSkilled:   [10, 30],
  scvExpCap:       [4,  14], expandMinScv:    [6,  16],
  keepMining:      [2,   8],
  reserveBase:     [4,  20], reserveSkilled:  [2,  14],
  waveIntervalInit:[60, 120],waveIntervalMin: [30,  70],
  waveIntervalMax: [80, 150],waveMin:         [6,  20],
  waveMultiplier:  [1.1, 2.0], waveOffset:    [2,   8],
  blindAttackMin:  [10,  30],
  raxCapBase:      [1,   5], raxCapSkilled:   [3,  10],
  raxTimeBase:     [60, 200],raxTimeSkilled:  [30, 100],
  uScv:    [0.3, 2.0], uMarine:  [0.3, 2.0], uFirebat: [0.2, 2.0],
  uRax:    [0.3, 2.0], uAcademy: [0.2, 2.0], uBunker:  [0.1, 2.0],
  uDepot:  [0.5, 2.5], uU238:    [0.1, 2.0],
};

function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

function mutate(cfg, sigma = 0.12) {
  const out = { ...cfg };
  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!(key in out)) continue;
    const range = hi - lo;
    const delta = (Math.random() * 2 - 1) * sigma * range;
    const raw   = out[key] + delta;
    // Integer params stay integer
    const isInt = Number.isInteger(cfg[key]);
    out[key] = isInt ? Math.round(clamp(raw, lo, hi)) : clamp(raw, lo, hi);
  }
  return out;
}

// ── Seed the initial champion from the game defaults ─────────────────────────
let champion = { ...DEFAULT_CFG };
let champFit = 0.5; // neutral — unknown vs itself

console.log(`Evolving BOT_CONFIG: ${GENERATIONS} generations × ${POPULATION} mutations × ${GAMES_PER_MATCH*2} games/match`);
console.log(`Patching back to HTML: ${PATCH_BACK}`);

// Baseline: champion vs itself should be ~0.5; skip first eval, just seed it.
if (VERBOSE) console.log('Gen 0 champion (default config)');

// ── Evolution loop ────────────────────────────────────────────────────────────
for (let gen = 1; gen <= GENERATIONS; gen++) {
  const candidates = Array.from({ length: POPULATION }, () => mutate(champion));

  let bestCand = null, bestFit = -1;
  for (const cand of candidates) {
    const fit = evaluate(cand, champion);
    if (fit > bestFit) { bestFit = fit; bestCand = cand; }
  }

  const improved = bestFit > 0.5; // strictly beats champion
  if (improved) {
    champion = bestCand;
    champFit = bestFit;
    if (VERBOSE || gen % 5 === 0)
      console.log(`Gen ${gen}: new champion  win-rate=${bestFit.toFixed(3)}`);
  } else {
    if (VERBOSE || gen % 5 === 0)
      console.log(`Gen ${gen}: no improvement (best=${bestFit.toFixed(3)})`);
  }
}

console.log('\nFinal champion config:');
console.log(JSON.stringify(champion, null, 2));

// ── Patch the result back into startext.html ──────────────────────────────────
if (PATCH_BACK) {
  const entries = Object.entries(champion)
    .map(([k, v]) => {
      const isInt = Number.isInteger(v);
      const str   = isInt ? String(v) : v.toFixed(2);
      return `  ${k}: ${str},`;
    })
    .join('\n');

  const newBlock = `const BOT_CONFIG_DEFAULT = {\n${entries}\n};`;

  const re = /const BOT_CONFIG_DEFAULT = \{[\s\S]*?\};/;
  const updated = html.replace(re, newBlock);
  if (updated === html) {
    console.error('WARNING: Could not find BOT_CONFIG_DEFAULT block to patch — check regex.');
  } else {
    fs.writeFileSync(HTML_PATH, updated, 'utf8');
    console.log(`\nPatched BOT_CONFIG_DEFAULT in ${path.basename(HTML_PATH)}`);
  }
}
