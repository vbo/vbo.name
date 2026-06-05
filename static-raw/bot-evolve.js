#!/usr/bin/env node
'use strict';
// Self-play evolutionary optimizer for startext.html BOT_CONFIG_DEFAULT.
// Reward: win ? 1 - ticks/MAX_TICKS : 0  (win fast > win slow > lose)
// Champion evolves against its own Hall of Fame to prevent cycling.
// Run from static-raw/:  node bot-evolve.js [--gen N] [--pop N] [--games N] [--hof N]

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? Number(args[i+1]) : def; };
const GENERATIONS     = argVal('--gen',   20);
const POPULATION      = argVal('--pop',   10);
const GAMES_PER_MATCH = argVal('--games',  5);
const HOF_SIZE        = argVal('--hof',    3);
const PATCH_BACK      = !args.includes('--no-patch');
const VERBOSE         = args.includes('--verbose');

// ── Load game ────────────────────────────────────────────────────────────────
const HTML_PATH = path.join(__dirname, 'startext.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const scriptStart = html.indexOf('<script>');
const scriptEnd   = html.indexOf('</script>', scriptStart);
if (scriptStart === -1 || scriptEnd === -1) { console.error('Cannot find <script> block'); process.exit(1); }
const gameScript = html.slice(scriptStart + '<script>'.length, scriptEnd);

// Promote key `let` vars to `var` so they become properties of the VM context.
const patchedScript = gameScript
  .replace(/^let (state\b)/m,            'var $1')
  .replace(/^let (BOT_CONFIG\b)/m,       'var $1')
  .replace(/^let (HUMAN_CONFIG\b)/m,     'var $1')
  .replace(/^let (ENABLE_HUMAN_BOT\b)/m, 'var $1')
  .replace(/^let (HOME\b)/m,             'var $1')
  .replace(/^let (AWAY\b)/m,             'var $1');
const ctx = { console };
vm.createContext(ctx);
const _log = console.log; console.log = () => {};
try { vm.runInContext(patchedScript, ctx); } finally { console.log = _log; }

// ── Game references ───────────────────────────────────────────────────────────
const { resetState, tick } = ctx;
if (!resetState || !tick) { console.error('Game globals not found — check script extraction'); process.exit(1); }

const DEFAULT_CFG = { ...ctx.BOT_CONFIG };

// Returns { win: 0|1, ticks: number }.
function runGame(botCfg, humanCfg, seed) {
  ctx.ENABLE_HUMAN_BOT = true;
  resetState(seed);
  // Set configs AFTER resetState so the default-reset inside doesn't clobber them.
  Object.assign(ctx.BOT_CONFIG,   DEFAULT_CFG, botCfg);
  Object.assign(ctx.HUMAN_CONFIG, DEFAULT_CFG, humanCfg);
  const MAX_TICKS = 1500;
  for (let t = 0; t < MAX_TICKS; t++) {
    tick();
    const s = ctx.state;
    const botCC   = s.buildings.some(b => b.owner === 'bot'   && b.type === 'cc' && !b.construct);
    const humanCC = s.buildings.some(b => b.owner === 'human' && b.type === 'cc' && !b.construct);
    if (!botCC || !humanCC) return { win: botCC ? 1 : 0, ticks: t };
  }
  const s = ctx.state;
  const botArmy   = s.units.filter(u => u.owner === 'bot'   && (u.type === 'marine' || u.type === 'firebat')).length;
  const humanArmy = s.units.filter(u => u.owner === 'human' && (u.type === 'marine' || u.type === 'firebat')).length;
  return { win: botArmy >= humanArmy ? 1 : 0, ticks: 1500 };
}

// Reward: winning faster is worth more; losing is 0.
const reward = (win, ticks) => win ? 1 - ticks / 1500 : 0;

// ── Evaluation ───────────────────────────────────────────────────────────────
// testCfg plays both sides (as bot and as "human") against every HoF entry.
function evaluate(testCfg, hof) {
  let total = 0, count = 0;
  for (const oppCfg of hof) {
    for (let g = 0; g < GAMES_PER_MATCH; g++) {
      const r1 = runGame(testCfg, oppCfg, g);
      total += reward(r1.win, r1.ticks);
      const r2 = runGame(oppCfg, testCfg, g);
      total += reward(1 - r2.win, r2.ticks);
      count += 2;
    }
  }
  return total / count;
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
  uEngBay: [0.1, 2.0], uInfWeapons: [0.1, 2.0], uInfArmor: [0.1, 2.0],
};

function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

function mutate(cfg, sigma = 0.12) {
  const out = { ...cfg };
  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    if (!(key in out)) continue;
    const range = hi - lo;
    const delta = (Math.random() * 2 - 1) * sigma * range;
    const raw   = out[key] + delta;
    const isInt = Number.isInteger(cfg[key]);
    out[key] = isInt ? Math.round(clamp(raw, lo, hi)) : clamp(raw, lo, hi);
  }
  // Expansion threshold must be reachable within base SCV cap.
  out.expandMinScv = Math.min(out.expandMinScv, out.scvCapBase);
  return out;
}

// ── Evolution ─────────────────────────────────────────────────────────────────
let champ = { ...DEFAULT_CFG };
const hof  = [{ ...DEFAULT_CFG }];

console.log(`Evolving BOT_CONFIG_DEFAULT: ${GENERATIONS} gens × ${POPULATION} mutations × ${GAMES_PER_MATCH*2} games/match × HoF ${HOF_SIZE}`);
console.log(`Patching back to HTML: ${PATCH_BACK}`);

for (let gen = 1; gen <= GENERATIONS; gen++) {
  const baseFit = evaluate(champ, hof);
  const cands = Array.from({ length: POPULATION }, () => mutate(champ));
  let best = null, bestFit = -1;
  for (const cand of cands) {
    const fit = evaluate(cand, hof);
    if (fit > bestFit) { bestFit = fit; best = cand; }
  }
  if (bestFit > baseFit) {
    champ = best;
    hof.push({ ...champ });
    if (hof.length > HOF_SIZE) hof.shift();
  }
  if (VERBOSE || gen % 5 === 0)
    console.log(`Gen ${gen}: fit=${bestFit.toFixed(3)} (base ${baseFit.toFixed(3)})`);
}

console.log('\nFinal config:');
console.log(JSON.stringify(champ, null, 2));

// ── Patch config back into startext.html ──────────────────────────────────────
function buildBlock(cfg) {
  const entries = Object.entries(cfg)
    .map(([k, v]) => `  ${k}: ${Number.isInteger(v) ? v : v.toFixed(2)},`)
    .join('\n');
  return `const BOT_CONFIG_DEFAULT = {\n${entries}\n};`;
}

if (PATCH_BACK) {
  const re = /const BOT_CONFIG_DEFAULT = \{[\s\S]*?\};/;
  const updated = html.replace(re, buildBlock(champ));
  if (updated === html) {
    console.error('WARNING: Could not find BOT_CONFIG_DEFAULT block to patch.');
  } else {
    fs.writeFileSync(HTML_PATH, updated, 'utf8');
    console.log(`\nPatched BOT_CONFIG_DEFAULT — wrote ${path.basename(HTML_PATH)}`);
  }
}
