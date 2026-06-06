Replay acceptance tests for startext bot evolution.

Each .txt file here is a replay log copied from the in-game "Copy replay log"
button on the victory screen. bot-evolve.js loads all .txt files and runs the
evolved champion against each one before patching the config back into
startext.html. The bot must beat every replay to be released.

Usage:
  node bot-evolve.js                  # evolve + validate + patch if all pass
  node bot-evolve.js --replay-only    # validate current config, no evolution
  node bot-evolve.js --force-patch    # patch even if some replays fail
  node bot-evolve.js --no-patch       # evolve + validate, print config only

How the replay bot works:
  The replay-bot plays the human side. It executes your recorded actions
  (build, train, attack) at the original tick numbers, retrying for up to
  120 ticks if blocked by insufficient resources or missing units. Idle SCVs
  auto-mine between actions. When the replay is exhausted the human side
  becomes passive (no AI), so the evolved bot needs to close out the win.

Naming: anything ending in .txt is loaded. Suggested format:
  YYYY-MM-DD-notes.txt
