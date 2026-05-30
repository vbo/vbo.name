# static-raw/ — working notes for Claude

Files here are copied verbatim into `public/` at build time (`hexo generate` doesn't touch them — see the `cpSync` step in `package.json`'s `build` script). Hexo's link validator (`npm run validate`) does check the copied output for broken links, but it doesn't parse JSX inside `<script type="text/babel">` blocks, so syntax errors in those land at runtime in the browser console.

## Git: how work reaches the live site (Claude self-merges)

The live site builds from `master`. The expected flow for Claude is:
develop on the task branch → open a PR → **squash-merge that PR to
`master` yourself** (no human reviewer is gating these). Don't stop at
"pushed to the branch" and wait — that branch is invisible to the user.
Do **not** `git push` directly to `master`; always go through a PR so the
squash-merge convention (and the conflict-avoidance below) holds. Bundle
any `CLAUDE.md`/workflow doc updates into the same PR before merging.

## Git: avoid the self-inflicted merge conflict

The repo squash-merges PRs to `master`. After a squash, the commit on master is a **new SHA** with the same content as the feature-branch commit. If a new task is built on top of the old feature-branch tip, git's 3-way merge sees the same line (e.g. `VERSION = '1.13'`) edited on both sides — once by master's squash, once by the new work — and flags a conflict even though only one author is involved.

**Before starting any new task on an existing branch**, re-anchor it to current master:

```
git fetch origin master
git checkout <branch-name>
git reset --hard origin/master   # only if the previous PR from this branch was already merged
```

Or, equivalently, just branch fresh off `origin/master` per task instead of reusing branches.

**Before pushing a follow-up**, rebase preemptively:

```
git fetch origin master
git rebase origin/master
```

Git's `--reapply-cherry-picks` detection automatically drops commits whose content is already on master (the squashed ones) — so the rebase is usually a no-op or applies only the genuinely new commits.

## multiply_kittens.html specifically

- Single HTML file, no build step for JSX. React 18 + Babel standalone + Tailwind, all via CDN.
- `VERSION` (top of file) bumps by 0.01 on every merge to master so the kid can tell builds apart. Bump it as part of the change, not as a follow-up commit.
- `runTests()` runs on page load and logs to the browser console. Add asserts when adding behaviour — there's no separate test runner.
- Detailed architecture / scheduling / strategy notes live in the top-of-file block comment inside the HTML itself.

## startext.html specifically

- Single HTML file, no build step, no dependencies — vanilla JS mini-RTS.
- The simulation is **DOM-free and deterministic**: `resetState(seed)` builds state, `tick()` advances it. All DOM/timer touches are guarded by `typeof document !== "undefined"`, and randomness goes through a seedable `rng()` (call `seedRng(n)`). This is what makes headless tests possible.
- **Tests live in the same file** (`runTests()` near the bottom). Run them headless and autonomously:

  ```
  cd static-raw
  sed -n '/<script>/,/<\/script>/p' startext.html | sed '1d;$d' | node -
  ```

  Prints `N passed, M failed` and exits non-zero on failure (~70ms). In a browser, open `startext.html?test` for the same report instead of the game.
- **Add an assert in `runTests()` whenever you add behaviour.** Each test does `resetState(seed)` then drives `tick()`; helpers (`ok`/`eq`/`near`/`run`) are defined at the top of the function. Combat auto-targets *threats* (idle units) first, so isolate buildings/units in setup when testing a specific interaction.
