# Test suite profile

Where the test time goes, what was done about it, and what is left. Minimums across repeated
runs throughout — the machine had competing load, and the minimum is the least-contaminated
estimate of what a suite actually costs.

## Headline

| suite | command | before | after | tests |
|---|---|---|---|---|
| core (vitest) | `npm test` | 6.2 s | **6.2 s** | 540 in 39 files |
| UI (browser) | `npm run test:ui` | 159.5 s | **99.9 s** | 337 checks in 30 groups |
| root vitest | `npx vitest run` | 21.1 s | **4.6 s** | 540, not 2104 |

The browser suite is **37% faster** and no longer the flake source it was: 8 consecutive green
runs at the end, against 3 failures in 7 runs when this started.

Core was measured and left alone — 11.3 s of work parallelised into 6.2 s of wall time, with
only `zpcrwebSettings` (3.1 s) and `pcrd` (3.1 s) above a second, both dominated by real
archive round-trips. There is nothing there worth trading clarity for.

## What was changed

### 1. The suite leaked a Chrome tab per check group

`Cdp.close()` closed only the WebSocket. The tab it was driving stayed open, still running the
app and holding an IndexedDB connection, so by the end of a run one Chrome held ~35 live copies
of the app.

The cost was not spread out. It landed almost entirely on `experimentNameChecks`, which spent
**26 s in setup before its first check**, because its `emptyReload` called
`deleteDatabase("zpcrweb")` while 25 other tabs still held that database open. `openPage` now
records the target id and `close()` closes the target too.

Measured alone: **154.7 s → 128.4 s**, and the run-to-run spread collapsed from 20 s to under 1 s.

### 2. 113 fixed `sleep()` calls, 54.5 s of dead time

Most were "click something, sleep 300 ms, read the DOM". They are now waits on the state being
asserted, through three new helpers in `harness.mjs`:

| helper | for |
|---|---|
| `waitValue(read, pred)` | poll until the value satisfies `pred` and **return it** — wait for the value to *change*, then let the `check` assert what it changed to. Returns the stale value on timeout instead of throwing, so a regression fails as its own check rather than as a bare harness timeout. |
| `waitStable(read)` | the value stopped changing. For state the app writes more than once per action. |
| `clickUntil(cdp, label, settled)` | re-click a control until it takes. |

83 of the 113 sleeps are gone. The 30 that remain are deliberate and each says why in a comment:
**negative assertions** (nothing happened — there is no state change to wait for) and **rate
limits** whose interval is a constant in the app (`DISK_WRITE_INTERVAL_MS` is 3 s, so
`folderChecks` outwaits it).

> One conversion was tried and reverted: polling the file's mtime instead of outwaiting the disk
> write throttle. An open `FileSystemWritableFileStream` holds an exclusive lock, so a reader
> arriving mid-write queues behind it — polling every 100 ms across the app's write window
> stalled the page long enough to trip the 30 s CDP watchdog. The 500 ms it might have saved was
> not worth racing the writer for. The comment in the code says so, so it isn't re-proposed.

### 3. `waitFor`'s poll interval, 150 ms → 50 ms

Every wait overshot by 75 ms on average across ~200 call sites. Worth ~8 s — but on its own it
*broke* the suite, which turned out to be the most useful thing it did (below).

### 4. `npx vitest run` walked into `.claude/worktrees/`

Those are complete checkouts of this repo, one per branch in flight, each with its own copy of
every test file. A root-level `npx vitest run` collected 152 files and 2104 tests instead of 39
and 540, and ran whatever stale code those branches were sitting on. A root `vitest.config.ts`
adds `**/.claude/**` to the default excludes: **21.1 s → 4.6 s**, and it now tests the working
tree rather than five of them. `npm test` was never affected — it runs `-w @zpcrweb/core`.

## Four real bugs the speedup exposed

Dropping the fixed sleeps turned three latent races into deterministic failures, which is how
they got found. All three were in the tests, not the app.

**`element?.click()` on a control React hasn't drawn is a silent no-op.** `clickTab` used it, so
a click that arrived early did nothing and the caller then waited out its own timeout on a view
it had never actually asked for. This was already failing runs intermittently before any of this
work — one baseline run died on it in `loadChecks` with `Cannot read properties of undefined
(reading 'click')`. `clickTab`, `clickButton` and `clickUntil` now wait for the control first.

**One check was passing vacuously.** `closeConfirmChecks`' "…and does not come back after a
reload" opened the Files tab and asserted the table was empty. With the last file closed the app
is on the welcome screen, which has no view bar and so no Files tab — the click silently did
nothing and the assertion passed on a table that was never rendered. It now asserts the welcome
screen, which is the stronger claim and the one that was meant.

**The Curves view mode can be seeded out from under a click.** The mode is restored from the
file's stored settings in an effect that runs after hydration, so a click landing in that window
is overwritten and the mode snaps back — `cqFilterChecks` then timed out on a table it had asked
for and had taken away from it. `clickUntil` rides it out. **This one is arguably an app bug**
rather than a test bug: a user clicking Table at the wrong moment loses the click too. It is
worth a look on its own.

**`history.back()` needs the hash to have settled.** The app writes the routing hash more than
once settling into a view, so acting on the first write can put `back()` on an entry that is
about to be superseded — "back() restores the previous view" failed intermittently, both before
and after this work. `waitStable` fixed it.

## Two flakes that were already there

Both were observed on unmodified `main` and are now gone, but neither was fixed here — the
commits that fixed them were the operator's, landing while this was being measured:

- `folderChecks`' "Granting the folder back reads in every open file in it" — failed 5 of 9 runs
  on `8ddad14`, fixed by `0497e1c` / `932c9db`.
- `closeConfirmChecks`' "timed out waiting for Overview's download button" — hit 3 of 7 runs on
  `ef2cc98`, patched and unpatched alike. Not seen since.

## Where the remaining 100 s goes

Per-group minimums from the original profile (30 groups, on `8ddad14`). The shape is what
matters — the three groups at the top were half the suite:

| group | checks | s |
|---|---|---|
| experiment names | 16 | 29.7 |
| disk folders | 29 | 15.4 |
| instrument runs and experiments | 47 | 12.1 |
| reference view rail (shared chips + dark overlay) | 16 | 6.1 |
| load from URL | 8 | 6.0 |
| open files and the selection | 7 | 6.0 |
| close confirmation | 11 | 5.7 |
| password handling | 8 | 5.6 |
| curves table mode (well/sample/target pickers) | 10 | 4.9 |
| curves chart (dragging a Cq marker) | 14 | 3.9 |

What is left is mostly irreducible: page loads, file parses and React renders, plus ~4 s of
startup (`tsup` build, Vite, Chrome) and the deliberate sleeps above.

### The one big lever not pulled

**Sharding across parallel Chrome profiles.** The 30 groups run sequentially; four shards in
separate Chrome instances (separate `--user-data-dir`, so separate IndexedDB) would put this
near 30 s. It was left alone deliberately:

- **The groups are not all independent.** `referenceChecks`, `tablePickChecks`, `cqDragChecks`
  and `wellHeaderChecks` never call `emptyReload` — they inherit the browser state a previous
  group left. Those chains have to stay together in one shard, so the split has to be authored,
  not derived.
- Output needs buffering per group or the log becomes unreadable.
- It is a structural change to how the suite runs, and worth doing on its own rather than
  bundled with a set of measured, individually-reversible fixes.
