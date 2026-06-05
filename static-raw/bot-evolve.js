#!/usr/bin/env node
'use strict';
// Coupled co-evolutionary optimizer for startext.html BOT_CONFIG profiles.
// Evolves two profiles simultaneously:
//   rusher — rewarded for winning EARLY  (fitness = 1 - ticks/MAX_TICKS)
//   macro  — rewarded for winning at all (fitness = binary win/loss)
// Each profile evolves against a Hall of Fame archive of the other's past
// champions, preventing cycling and preserving gradient.
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

// Capture defaults from the var copy (BOT_CONFIG_MACRO/RUSHER are const, not in ctx).
const DEFAULT_CFG = { ...ctx.BOT_CONFIG };

// Returns { win: 0|1, ticks: number }.
function runGame(botCfg, humanCfg, seed) {
  ctx.ENABLE_HUMAN_BOT = true;
  resetState(seed);
  // Set configs AFTER resetState so the profile-pick inside resetState doesn't clobber them.
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

// ── Reward functions ──────────────────────────────────────────────────────────
const rushReward  = (win, ticks) => win ? 1 - ticks / 1500 : 0;
const macroReward = (win, _ticks) => win;

// ── Evaluation ───────────────────────────────────────────────────────────────
// testCfg plays both sides against every entry in opponentArchive.
function evaluate(testCfg, opponentArchive, rewardFn) {
  let total = 0, count = 0;
  for (const oppCfg of opponentArchive) {
    for (let g = 0; g < GAMES_PER_MATCH; g++) {
      const r1 = runGame(testCfg, oppCfg, g);
      total += rewardFn(r1.win, r1.ticks);
      const r2 = runGame(oppCfg, testCfg, g);
      total += rewardFn(1 - r2.win, r2.ticks);
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
  // Cross-param: expansion threshold must be reachable within the base SCV cap.
  out.expandMinScv = Math.min(out.expandMinScv, out.scvCapBase);
  return out;
}

// ── Seed champions ────────────────────────────────────────────────────────────
// Macro starts from the current defaults (balanced/defensive).
// Rusher is seeded with explicitly aggressive values so it has gradient from
// the start: lean economy, fast barracks, low wave interval, no tech investment.
const RUSHER_SEED = {
  ...DEFAULT_CFG,
  scvCapBase: 8,    scvCapSkilled: 12,
  expandMinScv: 8,
  waveIntervalInit: 65, waveIntervalMin: 30, waveIntervalMax: 90,
  waveMin: 6,       waveMultiplier: 1.8,
  blindAttackMin: 11,
  raxCapBase: 4,    raxTimeBase: 80,  raxTimeSkilled: 40,
  uRax: 1.8,        uMarine: 1.6,     uFirebat: 1.6,
  uScv: 0.5,
  uAcademy: 0.2,    uU238: 0.2,
  uEngBay: 0.2,     uInfWeapons: 0.15, uInfArmor: 0.1,
  uBunker: 0.1,     uExpand: 0.3,
};
let champRush  = { ...RUSHER_SEED };
let champMacro = { ...DEFAULT_CFG };

// Hall of Fame: ring buffer of past champions; opponents are evaluated against all.
const hofRush  = [{ ...RUSHER_SEED }];
const hofMacro = [{ ...DEFAULT_CFG }];

console.log(`Co-evolving BOT_PROFILES: ${GENERATIONS} gens × ${POPULATION} mutations × ${GAMES_PER_MATCH*2} games/match × HoF ${HOF_SIZE}`);
console.log(`Patching back to HTML: ${PATCH_BACK}`);

// ── Co-evolution loop ─────────────────────────────────────────────────────────
for (let gen = 1; gen <= GENERATIONS; gen++) {
  // Half-step A: evolve rusher against current macro HoF (early-win reward).
  const rushBaseFit = evaluate(champRush, hofMacro, rushReward);
  const rushCands = Array.from({ length: POPULATION }, () => mutate(champRush));
  let bestRush = null, bestRushFit = -1;
  for (const cand of rushCands) {
    const fit = evaluate(cand, hofMacro, rushReward);
    if (fit > bestRushFit) { bestRushFit = fit; bestRush = cand; }
  }
  if (bestRushFit > rushBaseFit) {
    champRush = bestRush;
    hofRush.push({ ...champRush });
    if (hofRush.length > HOF_SIZE) hofRush.shift();
  }

  // Half-step B: evolve macro against current rusher HoF (eventual-win reward).
  const macroBaseFit = evaluate(champMacro, hofRush, macroReward);
  const macroCands = Array.from({ length: POPULATION }, () => mutate(champMacro));
  let bestMacro = null, bestMacroFit = -1;
  for (const cand of macroCands) {
    const fit = evaluate(cand, hofRush, macroReward);
    if (fit > bestMacroFit) { bestMacroFit = fit; bestMacro = cand; }
  }
  if (bestMacroFit > macroBaseFit) {
    champMacro = bestMacro;
    hofMacro.push({ ...champMacro });
    if (hofMacro.length > HOF_SIZE) hofMacro.shift();
  }

  if (VERBOSE || gen % 5 === 0)
    console.log(`Gen ${gen}: rusher=${bestRushFit.toFixed(3)}(base ${rushBaseFit.toFixed(3)})  macro=${bestMacroFit.toFixed(3)}(base ${macroBaseFit.toFixed(3)})`);
}

console.log('\nFinal rusher config:');
console.log(JSON.stringify(champRush, null, 2));
console.log('\nFinal macro config:');
console.log(JSON.stringify(champMacro, null, 2));

// ── Patch both profiles back into startext.html ───────────────────────────────
function buildBlock(name, cfg) {
  const entries = Object.entries(cfg)
    .map(([k, v]) => `  ${k}: ${Number.isInteger(v) ? v : v.toFixed(2)},`)
    .join('\n');
  return `const ${name} = {\n${entries}\n};`;
}

if (PATCH_BACK) {
  let updated = html;
  for (const [name, cfg] of [['BOT_CONFIG_RUSHER', champRush], ['BOT_CONFIG_MACRO', champMacro]]) {
    const re = new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`);
    const next = updated.replace(re, buildBlock(name, cfg));
    if (next === updated) {
      console.error(`WARNING: Could not find ${name} block to patch.`);
    } else {
      updated = next;
      console.log(`Patched ${name}`);
    }
  }
  fs.writeFileSync(HTML_PATH, updated, 'utf8');
  console.log(`\nWrote ${path.basename(HTML_PATH)}`);
}
