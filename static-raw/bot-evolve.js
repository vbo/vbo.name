#!/usr/bin/env node
'use strict';
// Self-play evolutionary optimizer for startext.html BOT_CONFIG_DEFAULT.
// Reward: win ? 1 - ticks/MAX_TICKS : 0  (win fast > win slow > lose)
// Champion evolves against its own Hall of Fame to prevent cycling.
// After training, champion is validated against all replay files in replays/.
//
// Run from static-raw/:
//   node bot-evolve.js [--gen N] [--pop N] [--games N] [--hof N]
//   node bot-evolve.js --no-patch           # evolve, print config, skip HTML patch
//   node bot-evolve.js --force-patch        # patch even if replay validation fails
//   node bot-evolve.js --replay-only        # skip evolution, validate current config against replays

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
const FORCE_PATCH     = args.includes('--force-patch');
const REPLAY_ONLY     = args.includes('--replay-only');
const POLICY_MODE     = args.includes('--policy');
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
  .replace(/^let (USE_MACRO_POLICY\b)/m, 'var $1')
  .replace(/^let (MACRO_WEIGHTS\b)/m,    'var $1')
  .replace(/^const (MACRO_WEIGHTS_DEFAULT\b)/m, 'var $1')
  .replace(/^let (USE_MILITARY_POLICY\b)/m, 'var $1')
  .replace(/^let (MILITARY_WEIGHTS\b)/m,    'var $1')
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
// Guarantee nonzero for any win (including timeout) so the evolution has signal.
const reward = (win, ticks) => win ? Math.max(0.1, 1 - ticks / 1500) : 0;

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

// ── Replay system ─────────────────────────────────────────────────────────────
const REPLAY_DIR = path.join(__dirname, 'replays');

// Costs mirroring C constants in startext.html — used to pre-check before calling
// game functions (which have the same checks internally but return nothing on fail).
const UNIT_COSTS  = { marine: { min: 50, gas: 0 }, firebat: { min: 50, gas: 25 }, scv: { min: 50, gas: 0 } };
const BUILD_COSTS = { barracks: 150, academy: 150, bunker: 100, depot: 100, refinery: 75, cc: 400, engbay: 150 };

// Parse a replay log (text from "Copy replay log") into { seed, logHome, logAway, actions }.
// seed is null when the log header shows "seed=?" (game started from an old save).
// logHome/logAway are the home-base node IDs extracted from first build/train actions.
// Only h: actions are returned; b: lines are parsed only to detect logAway.
function parseReplay(text) {
  const lines = text.split('\n');
  const header = lines[0] || '';
  const headerMatch = header.match(/seed=(\d+|\?)/);
  if (!headerMatch) return null;
  const seed = headerMatch[1] === '?' ? null : Number(headerMatch[1]);

  const actions = [];
  let logHome = null, logAway = null;

  for (const line of lines.slice(2)) { // skip header + column header
    // Detect logAway from first bot build/train line.
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

// For seed=? replays: find a seed where HOME/AWAY match the replay's logHome/logAway
// and expansion nodes have resources. Returns a numeric seed or null.
function findReplaySeed(replay, maxTry = 500) {
  if (replay.logHome === null || replay.logAway === null) return null;
  const lh = replay.logHome, la = replay.logAway;
  for (let s = 1; s <= maxTry; s++) {
    resetState(s);
    const st = ctx.state;
    if (ctx.HOME !== lh || ctx.AWAY !== la) continue;
    if (st.map.n < Math.max(lh, la) + 1) continue; // not enough nodes
    return s;
  }
  return null;
}

// Assign idle SCVs to available resources at their current node.
// Called each tick in replay games since ENABLE_HUMAN_BOT=false means no economy AI.
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

// Try to execute one replay action. Returns true if it fired, false to retry next tick.
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
      return s.minerals.human < before; // mineral spent → success
    }
    case 'research':
      return !!ctx.startResearch('human', action.type);
    case 'attack':
    case 'move': {
      // Only fire if units are actually there — they may not have arrived yet.
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

// Run the evolved bot against a replay-driven human side on the replay's seed.
function runReplayGame(botCfg, replay) {
  ctx.ENABLE_HUMAN_BOT = false; // we drive HUMAN manually via replay + autoMine

  let seed = replay.seed;
  if (seed === null) {
    seed = findReplaySeed(replay);
    if (seed === null) {
      if (VERBOSE) console.warn(`  No compatible seed for ${replay.name} (logHome=${replay.logHome}, logAway=${replay.logAway}) — skipping`);
      return { win: 1, ticks: 0 }; // treat unrunnable replay as pass so it doesn't block
    }
    if (VERBOSE) console.log(`  ${replay.name}: using seed ${seed} (matched logHome=${replay.logHome}, logAway=${replay.logAway})`);
  }

  resetState(seed);
  Object.assign(ctx.BOT_CONFIG, DEFAULT_CFG, botCfg);

  const pending = []; // [{action, age}] — actions that couldn't fire yet
  const MAX_RETRY = 120; // ticks before a stuck action is dropped
  let actionIdx = 0;
  let handedOff = false; // true once replay exhausted and normal AI takes over

  for (let t = 0; t < 1500; t++) {
    // Once replay queue is fully drained, hand control to the normal human AI.
    if (!handedOff && actionIdx >= replay.actions.length && pending.length === 0) {
      Object.assign(ctx.HUMAN_CONFIG, DEFAULT_CFG);
      ctx.ENABLE_HUMAN_BOT = true;
      handedOff = true;
    }

    if (!handedOff) {
      autoMineHuman();

      // Retry previously deferred actions
      const stillPending = [];
      for (const p of pending) {
        if (!tryReplayAction(p.action) && p.age < MAX_RETRY)
          stillPending.push({ action: p.action, age: p.age + 1 });
      }
      pending.length = 0; pending.push(...stillPending);

      // Fire actions due this tick
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
  const botArmy   = s.units.filter(u => u.owner === 'bot'   && (u.type === 'marine' || u.type === 'firebat')).length;
  const humanArmy = s.units.filter(u => u.owner === 'human' && (u.type === 'marine' || u.type === 'firebat')).length;
  return { win: botArmy >= humanArmy ? 1 : 0, ticks: 1500 };
}

// Load all .txt replay files from the replays/ directory.
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

// Validate champion against all replays. Returns true if all pass.
function validateReplays(cfg, replays) {
  if (!replays.length) return true;
  console.log(`\nValidating against ${replays.length} replay(s)...`);
  let passed = 0;
  for (const replay of replays) {
    const r = runReplayGame(cfg, replay);
    const ok = r.win === 1;
    if (ok) passed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${replay.name} (ended tick ${r.ticks})`);
  }
  ctx.ENABLE_HUMAN_BOT = true; // restore for any subsequent HoF games
  console.log(`  ${passed}/${replays.length} replays passed`);
  return passed === replays.length;
}

// ── Parameter bounds ─────────────────────────────────────────────────────────
const BOUNDS = {
  scvCapBase:      [6,  20], scvCapSkilled:   [10, 30],
  scvExpCap:       [4,  14], expandMinScv:    [6,  16],
  keepMining:      [2,   8],
  reserveBase:     [4,  12], reserveSkilled:  [2,  10],
  waveIntervalInit:[60, 120],waveIntervalMin: [30,  70],
  waveIntervalMax: [80, 150],waveMin:         [6,  20],
  waveMultiplier:  [1.1, 2.0], waveOffset:    [2,   8],
  blindAttackMin:  [10,  30],
  raxCapBase:      [1,   5], raxCapSkilled:   [3,  10],
  raxTimeBase:     [60, 200],raxTimeSkilled:  [30, 100],
  uScv:    [0.3, 2.0], uMarine:  [0.3, 2.0], uFirebat: [0.2, 2.0],
  uRax:    [0.3, 2.0], uAcademy: [0.2, 2.0], uRefinery:[0.3, 2.0], uBunker:  [0.1, 2.0],
  uDepot:  [0.5, 2.5], uU238:    [0.1, 2.0],
  uEngBay: [0.1, 2.0], uInfWeapons: [0.3, 2.0], uInfArmor: [0.3, 2.0],
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

// ── Load replays upfront ──────────────────────────────────────────────────────
const replays = loadReplays();

// ── Macro-policy prototype: train + benchmark vs the rule bot ──────────────────
// `--policy` evolves the generic linear policy (MACRO_WEIGHTS) by self-play, then
// measures it head-to-head against the current rule bot and against the replay
// gate. It does NOT patch anything — this is the "prototype + compare" step: we
// decide whether to adopt the policy based on these measured numbers.
const MACRO_KEYS    = Object.keys(ctx.MACRO_WEIGHTS_DEFAULT);
const MIL_KEYS      = Object.keys(ctx.MILITARY_WEIGHTS_DEFAULT);
const POLICY_BOUNDS = [-6, 6];

// A "brain" is { macro, mil } weight objects. The genome we evolve is both at
// once, since macro and military decisions interact (army size feeds attack).
function defaultBrain() {
  return { macro: { ...ctx.MACRO_WEIGHTS_DEFAULT }, mil: { ...ctx.MILITARY_WEIGHTS_DEFAULT } };
}
function cloneBrain(b) { return { macro: { ...b.macro }, mil: { ...b.mil } }; }

function mutatePolicy(b, sigma = 0.15) {
  const out = cloneBrain(b);
  const span = POLICY_BOUNDS[1] - POLICY_BOUNDS[0];
  for (const k of MACRO_KEYS)
    out.macro[k] = clamp((out.macro[k] ?? 0) + (Math.random() * 2 - 1) * sigma * span, POLICY_BOUNDS[0], POLICY_BOUNDS[1]);
  for (const k of MIL_KEYS) {
    // `reserve` is a unit count, not a feature weight — mutate on its own scale.
    if (k === 'reserve') { out.mil.reserve = clamp((out.mil.reserve ?? 8) + (Math.random()*2-1)*3, 0, 20); continue; }
    out.mil[k] = clamp((out.mil[k] ?? 0) + (Math.random() * 2 - 1) * sigma * span, POLICY_BOUNDS[0], POLICY_BOUNDS[1]);
  }
  return out;
}

// Apply a brain to one side's cfg (or leave it as the rule bot when brain is null).
function applyBrain(cfg, brain) {
  cfg.useMacroPolicy    = !!brain;
  cfg.macroWeights      = brain ? brain.macro : null;
  cfg.useMilitaryPolicy = !!brain;
  cfg.militaryWeights   = brain ? brain.mil : null;
}

// Run a game with explicit per-side brains. brain object → generic policy;
// null → the hand-written rule bot.
function runBrainGame(botBrain, humanBrain, seed) {
  ctx.ENABLE_HUMAN_BOT = true;
  ctx.USE_MACRO_POLICY = false; ctx.USE_MILITARY_POLICY = false; // per-side via cfg
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

// Fitness of a policy weight-set. Opponents = the policy Hall of Fame PLUS the
// rule bot as a permanent anchor, so fitness has an absolute reference point and
// stops drifting purely with co-evolution. Each matchup is played on `games`
// distinct seeds, both colours, to cut variance.
function evaluatePolicy(brain, hof, games) {
  let total = 0, count = 0;
  const opps = hof.concat([null]); // null = rule bot anchor
  for (const opp of opps) {
    for (let g = 0; g < games; g++) {
      const r1 = runBrainGame(brain, opp, g); total += reward(r1.win, r1.ticks);
      const r2 = runBrainGame(opp, brain, g); total += reward(1 - r2.win, r2.ticks);
      count += 2;
    }
  }
  return total / count;
}

// Head-to-head: policy bot vs the rule bot, both colours, over `seeds` maps.
function benchVsRule(brain, seeds) {
  let pol = 0, rule = 0;
  for (let s = 0; s < seeds; s++) {
    if (runBrainGame(brain, null, s).win) pol++; else rule++;   // policy as bot
    if (runBrainGame(null, brain, s).win) rule++; else pol++;   // policy as human
  }
  return { pol, rule, total: seeds * 2 };
}

// Replay gate with the policy bot driving the AI side.
function policyReplay(brain) {
  applyBrain(ctx.HUMAN_CONFIG, null); // scripted human handoff stays rule-driven
  return replays.map(r => {
    const out = runReplayGame({
      useMacroPolicy: true,    macroWeights:    brain.macro,
      useMilitaryPolicy: true, militaryWeights: brain.mil,
    }, r);
    return { name: r.name, win: out.win, ticks: out.ticks };
  });
}

if (POLICY_MODE) {
  const games = GAMES_PER_MATCH;
  const hofN  = HOF_SIZE;
  console.log(`Policy prototype: evolving macro+military weights — ${GENERATIONS} gens × ${POPULATION} mutations × ${games*2} games/match × HoF ${hofN}`);
  console.log(`Genome: ${MACRO_KEYS.length} macro + ${MIL_KEYS.length} military weights   Replay files: ${replays.length}\n`);

  let champ = defaultBrain();
  const hof = [cloneBrain(champ)];

  // Validation-based selection: the objective is beating the rule bot, so we keep
  // the brain with the best MEASURED win rate vs the rule bot (not just the best
  // self-play fitness, which can overfit the Hall of Fame). 12-seed bench.
  const VAL_SEEDS = 12;
  const valScore = b => benchVsRule(b, VAL_SEEDS).pol; // wins out of VAL_SEEDS*2
  let elite = cloneBrain(champ), eliteScore = valScore(elite);
  console.log(`Warm-start vs rule bot: ${eliteScore}/${VAL_SEEDS * 2} wins\n`);

  for (let gen = 1; gen <= GENERATIONS; gen++) {
    const baseFit = evaluatePolicy(champ, hof, games);
    let best = null, bestFit = -1;
    for (let p = 0; p < POPULATION; p++) {
      const cand = mutatePolicy(champ);
      const fit  = evaluatePolicy(cand, hof, games);
      if (fit > bestFit) { bestFit = fit; best = cand; }
    }
    if (bestFit > baseFit) {
      champ = best;
      hof.push(cloneBrain(champ));
      if (hof.length > hofN) hof.shift();
    }
    // Track the best champion by absolute benchmark, not co-evolution fitness.
    const cScore = valScore(champ);
    if (cScore > eliteScore) { eliteScore = cScore; elite = cloneBrain(champ); }
    if (VERBOSE || gen % 5 === 0)
      console.log(`Gen ${gen}: selfplay-fit=${bestFit.toFixed(3)}  vs-rule=${cScore}/${VAL_SEEDS * 2}  (elite ${eliteScore})`);
  }

  champ = elite; // ship the validation champion
  console.log('\n── Results ───────────────────────────────────────────────');
  const final = benchVsRule(champ, 20);
  console.log(`Trained policy vs rule bot (40 games): policy ${final.pol} — rule ${final.rule}  (${(100*final.pol/final.total).toFixed(0)}% policy)`);

  const rep = policyReplay(champ);
  for (const r of rep) console.log(`  replay ${r.name}: ${r.win ? 'PASS' : 'FAIL'} (tick ${r.ticks})`);

  console.log('\nTrained brain (macro + military weights):');
  console.log(JSON.stringify(champ, null, 2));
  console.log('\n(prototype only — nothing patched; rule bot remains the live AI)');
  process.exit(0);
}

// ── Evolution (skipped with --replay-only) ────────────────────────────────────
let champ = { ...DEFAULT_CFG };

if (!REPLAY_ONLY) {
  const hof = [{ ...DEFAULT_CFG }];
  console.log(`Evolving BOT_CONFIG_DEFAULT: ${GENERATIONS} gens × ${POPULATION} mutations × ${GAMES_PER_MATCH*2} games/match × HoF ${HOF_SIZE}`);
  console.log(`Replay files: ${replays.length}   Patch back: ${PATCH_BACK}   Force patch: ${FORCE_PATCH}`);

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
} else {
  console.log(`--replay-only: testing current BOT_CONFIG_DEFAULT against ${replays.length} replay(s)`);
}

// ── Replay validation ─────────────────────────────────────────────────────────
const replayPass = validateReplays(champ, replays);

// ── Patch config back into startext.html ──────────────────────────────────────
function buildBlock(cfg) {
  const entries = Object.entries(cfg)
    .map(([k, v]) => `  ${k}: ${Number.isInteger(v) ? v : v.toFixed(2)},`)
    .join('\n');
  return `const BOT_CONFIG_DEFAULT = {\n${entries}\n};`;
}

if (PATCH_BACK && !REPLAY_ONLY) {
  if (!replayPass && !FORCE_PATCH) {
    console.log('\nChampion failed replay validation — config NOT patched.');
    console.log('Fix the bot or use --force-patch to override.');
  } else {
    // Re-read HTML so replay-game calls above don't affect the in-memory `html` string.
    const currentHtml = fs.readFileSync(HTML_PATH, 'utf8');
    const re = /const BOT_CONFIG_DEFAULT = \{[\s\S]*?\};/;
    const updated = currentHtml.replace(re, buildBlock(champ));
    if (updated === currentHtml) {
      console.error('WARNING: Could not find BOT_CONFIG_DEFAULT block to patch.');
    } else {
      fs.writeFileSync(HTML_PATH, updated, 'utf8');
      console.log(`\nPatched BOT_CONFIG_DEFAULT — wrote ${path.basename(HTML_PATH)}`);
    }
  }
}
