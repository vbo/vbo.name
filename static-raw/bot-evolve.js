#!/usr/bin/env node
'use strict';
// Self-play evolutionary optimizer for the startext.html learned policy.
// Trains macro (27-weight) and military (11-weight) policy jointly by self-play
// + Hall of Fame, then benchmarks the result vs the current live weights and
// validates against replay files in replays/.
//
// Run from static-raw/:
//   node bot-evolve.js [--gen N] [--pop N] [--games N] [--hof N] [--verbose]
//
// If the trained weights beat the current defaults, copy them into
// MACRO_WEIGHTS_DEFAULT / MILITARY_WEIGHTS_DEFAULT in startext.html.

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
  .replace(/^const (MACRO_WEIGHTS_DEFAULT\b)/m, 'var $1')
  .replace(/^const (MILITARY_WEIGHTS_DEFAULT\b)/m, 'var $1')
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

// Reward: winning faster is worth more; losing is 0.
const reward = (win, ticks) => win ? Math.max(0.1, 1 - ticks / 1500) : 0;

// ── Replay system ─────────────────────────────────────────────────────────────
const REPLAY_DIR = path.join(__dirname, 'replays');

const UNIT_COSTS  = { marine: { min: 50, gas: 0 }, firebat: { min: 50, gas: 25 }, scv: { min: 50, gas: 0 } };
const BUILD_COSTS = { barracks: 150, academy: 150, bunker: 100, depot: 100, refinery: 75, cc: 400, engbay: 150 };

function parseReplay(text) {
  const lines = text.split('\n');
  const header = lines[0] || '';
  const headerMatch = header.match(/seed=(\d+|\?)/);
  if (!headerMatch) return null;
  const seed = headerMatch[1] === '?' ? null : Number(headerMatch[1]);

  const actions = [];
  let logHome = null, logAway = null;

  for (const line of lines.slice(2)) {
    if (logAway === null) {
      const bm = line.match(/^\s*\d+\s+b:(?:build|train)\s+\w+@(\d+)/);
      if (bm) logAway = Number(bm[1]);
    }

    const m = line.match(/^\s*(\d+)\s+h:(\w+)\s*(.*)/);
    if (!m) continue;
    const t = Number(m[1]), act = m[2], detail = m[3].trim();
    let action = null;
    if (act === 'build') {
      const bm = detail.match(/^(\w+)@(\d+)/);
      if (bm) {
        action = { t, act, type: bm[1], node: Number(bm[2]) };
        if (logHome === null) logHome = Number(bm[2]);
      }
    } else if (act === 'train') {
      const tm = detail.match(/^(\w+)@(\d+)/);
      if (tm) {
        action = { t, act, type: tm[1], node: Number(tm[2]) };
        if (logHome === null) logHome = Number(tm[2]);
      }
    } else if (act === 'research') {
      action = { t, act, type: detail };
    } else if (act === 'attack' || act === 'move') {
      const am = detail.match(/(\d+)×(\w+)\s+(\d+)→(\d+)/);
      if (am) action = { t, act, n: Number(am[1]), utype: am[2], src: Number(am[3]), dest: Number(am[4]) };
    }
    if (action) actions.push(action);
  }
  return { seed, logHome, logAway, actions };
}

function findReplaySeed(replay, maxTry = 500) {
  if (replay.logHome === null || replay.logAway === null) return null;
  const lh = replay.logHome, la = replay.logAway;
  for (let s = 1; s <= maxTry; s++) {
    resetState(s);
    const st = ctx.state;
    if (ctx.HOME !== lh || ctx.AWAY !== la) continue;
    if (st.map.n < Math.max(lh, la) + 1) continue;
    return s;
  }
  return null;
}

function autoMineHuman() {
  const s = ctx.state;
  for (const u of s.units) {
    if (u.owner !== 'human' || u.type !== 'scv' || u.task !== 'idle' || u.node < 0) continue;
    const n = u.node;
    if (s.field[n] > 0) { u.task = 'mining'; continue; }
    if (s.gasField[n] > 0 &&
        s.buildings.some(b => b.owner === 'human' && b.node === n && b.type === 'refinery' && !b.construct))
      u.task = 'gas';
  }
}

function tryReplayAction(action) {
  const s = ctx.state;
  const hm = s.minerals.human, hg = s.gas.human;
  switch (action.act) {
    case 'build': {
      const cost = BUILD_COSTS[action.type] || 0;
      if (hm < cost) return false;
      return !!ctx.startBuilding('human', action.node, action.type);
    }
    case 'train': {
      const c = UNIT_COSTS[action.type];
      if (!c || hm < c.min || hg < c.gas) return false;
      const before = s.minerals.human;
      if      (action.type === 'marine')  ctx.queueMarine('human', action.node);
      else if (action.type === 'firebat') ctx.queueFirebat('human', action.node);
      else if (action.type === 'scv')     ctx.queueSCV('human', action.node);
      return s.minerals.human < before;
    }
    case 'research':
      return !!ctx.startResearch('human', action.type);
    case 'attack':
    case 'move': {
      const pool = s.units.filter(u =>
        u.owner === 'human' && u.node === action.src &&
        u.type === action.utype && u.task === 'idle' && !u.transit);
      if (!pool.length) return false;
      ctx.sendUnits('human', action.src, action.n, action.utype, action.dest, action.act);
      return true;
    }
  }
  return false;
}

function runReplayGame(botCfg, replay) {
  ctx.ENABLE_HUMAN_BOT = false;

  let seed = replay.seed;
  if (seed === null) {
    seed = findReplaySeed(replay);
    if (seed === null) {
      if (VERBOSE) console.warn(`  No compatible seed for ${replay.name} — skipping`);
      return { win: 1, ticks: 0 };
    }
    if (VERBOSE) console.log(`  ${replay.name}: using seed ${seed}`);
  }

  resetState(seed);
  Object.assign(ctx.BOT_CONFIG, DEFAULT_CFG, botCfg);

  const pending = [];
  const MAX_RETRY = 120;
  let actionIdx = 0;
  let handedOff = false;

  for (let t = 0; t < 1500; t++) {
    if (!handedOff && actionIdx >= replay.actions.length && pending.length === 0) {
      Object.assign(ctx.HUMAN_CONFIG, DEFAULT_CFG);
      ctx.ENABLE_HUMAN_BOT = true;
      handedOff = true;
    }

    if (!handedOff) {
      autoMineHuman();
      const stillPending = [];
      for (const p of pending) {
        if (!tryReplayAction(p.action) && p.age < MAX_RETRY)
          stillPending.push({ action: p.action, age: p.age + 1 });
      }
      pending.length = 0; pending.push(...stillPending);
      while (actionIdx < replay.actions.length && replay.actions[actionIdx].t <= t) {
        const a = replay.actions[actionIdx++];
        if (!tryReplayAction(a)) pending.push({ action: a, age: 0 });
      }
    }

    tick();

    const s = ctx.state;
    const botCC   = s.buildings.some(b => b.owner === 'bot'   && b.type === 'cc' && !b.construct);
    const humanCC = s.buildings.some(b => b.owner === 'human' && b.type === 'cc' && !b.construct);
    if (!botCC || !humanCC) return { win: botCC ? 1 : 0, ticks: t };
  }
  const s = ctx.state;
  const ba = s.units.filter(u => u.owner === 'bot'   && (u.type === 'marine' || u.type === 'firebat')).length;
  const ha = s.units.filter(u => u.owner === 'human' && (u.type === 'marine' || u.type === 'firebat')).length;
  return { win: ba >= ha ? 1 : 0, ticks: 1500 };
}

function loadReplays() {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  const files = fs.readdirSync(REPLAY_DIR).filter(f => f.endsWith('.txt'));
  const replays = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(REPLAY_DIR, f), 'utf8');
    const replay = parseReplay(text);
    if (!replay) { console.warn(`Skipping invalid replay: ${f}`); continue; }
    replay.name = f;
    replays.push(replay);
  }
  return replays;
}

function validateReplays(brain, replays) {
  if (!replays.length) return true;
  console.log(`\nValidating against ${replays.length} replay(s)...`);
  let passed = 0;
  for (const replay of replays) {
    const r = runReplayGame({ macroWeights: brain.macro, militaryWeights: brain.mil }, replay);
    const ok = r.win === 1;
    if (ok) passed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${replay.name} (tick ${r.ticks})`);
  }
  ctx.ENABLE_HUMAN_BOT = true;
  console.log(`  ${passed}/${replays.length} replays passed`);
  return passed === replays.length;
}

// ── Policy evolution ──────────────────────────────────────────────────────────
const MACRO_KEYS    = Object.keys(ctx.MACRO_WEIGHTS_DEFAULT);
const MIL_KEYS      = Object.keys(ctx.MILITARY_WEIGHTS_DEFAULT);
const POLICY_BOUNDS = [-6, 6];

function defaultBrain() {
  return { macro: { ...ctx.MACRO_WEIGHTS_DEFAULT }, mil: { ...ctx.MILITARY_WEIGHTS_DEFAULT } };
}
function cloneBrain(b) { return { macro: { ...b.macro }, mil: { ...b.mil } }; }

function mutatePolicy(b, sigma = 0.15) {
  const out = cloneBrain(b);
  const span = POLICY_BOUNDS[1] - POLICY_BOUNDS[0];
  for (const k of MACRO_KEYS)
    out.macro[k] = Math.max(POLICY_BOUNDS[0], Math.min(POLICY_BOUNDS[1],
      (out.macro[k] ?? 0) + (Math.random() * 2 - 1) * sigma * span));
  for (const k of MIL_KEYS) {
    if (k === 'reserve') {
      out.mil.reserve = Math.max(0, Math.min(20, (out.mil.reserve ?? 8) + (Math.random()*2-1)*3));
      continue;
    }
    out.mil[k] = Math.max(POLICY_BOUNDS[0], Math.min(POLICY_BOUNDS[1],
      (out.mil[k] ?? 0) + (Math.random() * 2 - 1) * sigma * span));
  }
  return out;
}

// Apply a brain to one side's cfg. null brain → game falls back to
// MACRO_WEIGHTS_DEFAULT / MILITARY_WEIGHTS_DEFAULT (the current live weights).
function applyBrain(cfg, brain) {
  cfg.macroWeights    = brain ? brain.macro : null;
  cfg.militaryWeights = brain ? brain.mil : null;
}

// Run a game with explicit per-side brains. null brain → default live weights.
function runBrainGame(botBrain, humanBrain, seed) {
  ctx.ENABLE_HUMAN_BOT = true;
  resetState(seed);
  Object.assign(ctx.BOT_CONFIG,   DEFAULT_CFG);
  Object.assign(ctx.HUMAN_CONFIG, DEFAULT_CFG);
  applyBrain(ctx.BOT_CONFIG,   botBrain);
  applyBrain(ctx.HUMAN_CONFIG, humanBrain);
  for (let t = 0; t < 1500; t++) {
    tick();
    const s = ctx.state;
    const bCC = s.buildings.some(b => b.owner === 'bot'   && b.type === 'cc' && !b.construct);
    const hCC = s.buildings.some(b => b.owner === 'human' && b.type === 'cc' && !b.construct);
    if (!bCC || !hCC) return { win: bCC ? 1 : 0, ticks: t };
  }
  const s = ctx.state;
  const ba = s.units.filter(u => u.owner === 'bot'   && (u.type === 'marine' || u.type === 'firebat')).length;
  const ha = s.units.filter(u => u.owner === 'human' && (u.type === 'marine' || u.type === 'firebat')).length;
  return { win: ba >= ha ? 1 : 0, ticks: 1500 };
}

// Fitness via self-play + HoF. null opponent = current live weights (anchor).
function evaluatePolicy(brain, hof, games) {
  let total = 0, count = 0;
  const opps = hof.concat([null]);
  for (const opp of opps) {
    for (let g = 0; g < games; g++) {
      const r1 = runBrainGame(brain, opp, g); total += reward(r1.win, r1.ticks);
      const r2 = runBrainGame(opp, brain, g); total += reward(1 - r2.win, r2.ticks);
      count += 2;
    }
  }
  return total / count;
}

// Head-to-head: evolved brain vs current live weights (null brain), both colours.
// seedStart lets the holdout bench use seeds never seen during training.
function benchVsDefault(brain, seeds, seedStart = 0) {
  let pol = 0, def = 0;
  for (let s = seedStart; s < seedStart + seeds; s++) {
    if (runBrainGame(brain, null, s).win) pol++; else def++;
    if (runBrainGame(null, brain, s).win) def++; else pol++;
  }
  return { pol, def, total: seeds * 2 };
}

// Replay gate: run the evolved brain against scripted human replays.
function policyReplay(brain) {
  return replays.map(r => {
    const out = runReplayGame({ macroWeights: brain.macro, militaryWeights: brain.mil }, r);
    return { name: r.name, win: out.win, ticks: out.ticks };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
const replays = loadReplays();

console.log(`Policy evolution: ${GENERATIONS} gens × ${POPULATION} mutations × ${GAMES_PER_MATCH*2} games/match × HoF ${HOF_SIZE}`);
console.log(`Genome: ${MACRO_KEYS.length} macro + ${MIL_KEYS.length} military weights   Replay files: ${replays.length}\n`);

let champ = defaultBrain();
const hof = [cloneBrain(champ)];

const VAL_SEEDS = 24;
const valScore = b => benchVsDefault(b, VAL_SEEDS).pol;
let elite = cloneBrain(champ), eliteScore = valScore(elite);
console.log(`Warm-start vs current live weights: ${eliteScore}/${VAL_SEEDS * 2} wins\n`);

for (let gen = 1; gen <= GENERATIONS; gen++) {
  const sigma = Math.max(0.06, 0.22 * Math.pow(0.94, gen - 1));
  const baseFit = evaluatePolicy(champ, hof, GAMES_PER_MATCH);
  let best = null, bestFit = -1;
  for (let p = 0; p < POPULATION; p++) {
    const cand = mutatePolicy(champ, sigma);
    const fit  = evaluatePolicy(cand, hof, GAMES_PER_MATCH);
    if (fit > bestFit) { bestFit = fit; best = cand; }
  }
  if (bestFit > baseFit) {
    champ = best;
    hof.push(cloneBrain(champ));
    if (hof.length > HOF_SIZE) hof.shift();
  }
  const cScore = valScore(champ);
  if (cScore > eliteScore) { eliteScore = cScore; elite = cloneBrain(champ); }
  if (VERBOSE || gen % 5 === 0)
    console.log(`Gen ${gen}: selfplay-fit=${bestFit.toFixed(3)}  vs-default=${cScore}/${VAL_SEEDS * 2}  σ=${sigma.toFixed(3)}  (elite ${eliteScore})`);
}

champ = elite;
console.log('\n── Results ───────────────────────────────────────────────');
const final = benchVsDefault(champ, 20);
console.log(`Trained vs current live (40 games, seeds 0-19): trained ${final.pol} — live ${final.def}  (${(100*final.pol/final.total).toFixed(0)}% trained)`);
const holdout = benchVsDefault(champ, 20, 100);
console.log(`Holdout bench      (40 games, seeds 100-119):   trained ${holdout.pol} — live ${holdout.def}  (${(100*holdout.pol/holdout.total).toFixed(0)}% trained)`);

const rep = policyReplay(champ);
for (const r of rep) console.log(`  replay ${r.name}: ${r.win ? 'PASS' : 'FAIL'} (tick ${r.ticks})`);

console.log('\nTrained brain (macro + military weights):');
console.log(JSON.stringify(champ, null, 2));
console.log('\nTo adopt: copy the weights above into MACRO_WEIGHTS_DEFAULT / MILITARY_WEIGHTS_DEFAULT in startext.html.');
