# Test suite profile

Where the test time goes, what was done about it, and what is left. Minimums across repeated
runs throughout — the machine had competing load, and the minimum is the least-contaminated
estimate of what a suite actually costs.

## Headline

| suite | command | before | after | tests |
|---|---|---|---|---|
| core (vitest) | `npm test` | 6.2 s | **6.2 s** | 581 in 42 files |
| UI (browser) | `npm run test:ui` | 159.5 s | **55.5 s** | 340 checks in 33 groups |
| root vitest | `npx vitest run` | 21.1 s | **4.6 s** | 540, not 2104 |

The browser suite is **65% faster** and no longer the flake source it was: 4 consecutive green runs
at the end within a 0.8 s spread, against 3 failures in 7 runs when this started.

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

Across this and the write-behind change below, the 113 sleeps are down to **31** (and to **27**
with §7), and the 54.5 s they cost is down to **13.2 s**. What remains is deliberate and each one says why in a comment:
mostly **negative assertions**, where nothing is going to happen and so there is no state change to
wait for.

> One conversion was tried and reverted: polling the file's mtime instead of outwaiting the disk
> write throttle. An open `FileSystemWritableFileStream` holds an exclusive lock, so a reader
> arriving mid-write queues behind it — polling every 100 ms across the app's write window
> stalled the page long enough to trip the 30 s CDP watchdog. The 500 ms it might have saved was
> not worth racing the writer for. The comment in the code says so, so it isn't re-proposed.

### 3. Don't wait out a write-behind interval — hide the page

The app writes to storage behind a rate limiter: 3 s for the write-back to a file on disk, 2 s for
a protocol edit, and **60 s** for a `.zpcr`'s analysis settings. Six checks want the edit *on
storage* rather than merely on screen, and were each sleeping through some part of that.

They don't have to, and no test-only hook is needed for it. `WriteThrottle.attach` already flushes
everything pending on `visibilitychange` → hidden, because a backgrounded tab may never come back.
`flushWrites(cdp)` drives that same listener from outside — the shortcut the tests want is the
production path.

Two details worth recording:

- **Chrome removed `Emulation.setPageVisibilityState`**, and `Page.setWebLifecycleState` freezes
  the page without reliably thawing it — it stayed `hidden`, which throttles every timer
  afterwards. So the helper overrides `document.visibilityState` for exactly as long as the event
  takes to dispatch and puts it straight back.
- **The flush is started, not awaited.** The listener is `void this.flushAll()`, so there is no
  completion signal. Callers still wait for the write to land — but for something short and
  bounded rather than for a rate limit.

Worth 5.6 s of sleeping (18.8 s of fixed waits down to 13.2 s), and it removes the suite's
dependence on *guessing* that a given edit is the first one in its window — the one the limiter
writes immediately. A second edit inside the window is a pending trailing write, and those checks
were previously passing only because navigating away fires `pagehide`, which flushes too:
accidentally correct, and now deliberate.

**One check still waits out the real timer**, and must: `folderChecks`' "An edit in the app is
written back to the real file on disk". Since `flushWrites` short-circuits the timer everywhere
else, a suite with no such check would pass with the timer removed entirely.

### 4. `waitFor`'s poll interval, 150 ms → 50 ms

Every wait overshot by 75 ms on average across ~200 call sites. Worth ~8 s — but on its own it
*broke* the suite, which turned out to be the most useful thing it did (below).

### 5. `npx vitest run` walked into `.claude/worktrees/`

Those are complete checkouts of this repo, one per branch in flight, each with its own copy of
every test file. A root-level `npx vitest run` collected 152 files and 2104 tests instead of 39
and 540, and ran whatever stale code those branches were sitting on. A root `vitest.config.ts`
adds `**/.claude/**` to the default excludes: **21.1 s → 4.6 s**, and it now tests the working
tree rather than five of them. `npm test` was never affected — it runs `-w @zpcrweb/core`.

## Six real bugs the speedup exposed

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

**A hash write plus `tabBecomes` is not a navigation.** `tabBecomes` *reports* where the view
settled rather than insisting on it, so a hash write that lost a race left `closeConfirmChecks` on
the Files view and the next wait timed out on a button that was never going to appear. This is the
intermittent "timed out waiting for Overview's download button" reported earlier as a main-side
flake — it was in the test. It uses `clickTab` now, which presses the tab and confirms it took.

**A single synthesized mouse move can be dropped.** After a Cq drag, `cqDragChecks` moved the
pointer once to prove the plot is not left deaf. The drag's teardown finishes a frame or two after
`is-cqdrag` clears, and a move arriving inside that window lands on a plot whose `pointerEvents` is
still `none` — dropped, with nothing else arriving to re-arm the cursor. A real pointer emits a
stream of moves; the check re-dispatches until it takes.

## One flake that was already there

Observed on unmodified `main` and now gone, but not fixed here — the commits that fixed it were
the operator's, landing while this was being measured:

- `folderChecks`' "Granting the folder back reads in every open file in it" — failed 5 of 9 runs
  on `8ddad14`, fixed by `0497e1c` / `932c9db`.

(The other one reported at the time, `closeConfirmChecks`' download button, turned out to be the
test's own race — see above.)

### 6. Two `resetWells()` calls that had nothing to undo — 16 s

`tablePickChecks` reset the well selection after each of its three picks. Only the *Well* pick
isolates wells; a Sample or Target pick leaves them alone — which is exactly what the check
"…and leaves the other dimensions alone" asserts one line later. So the other two resets clicked a
control that changed nothing and then sat in `waitValue` for the full 8 s default waiting for a
count that was never going to move. Both checks passed the whole time, because `waitValue` returns
the stale value rather than throwing; the cost was invisible in the pass/fail output and showed up
only as two 8.1 s gaps in a per-check timing run.

**A `waitValue` that always times out is a silent 8 s.** It is the one helper whose misuse doesn't
announce itself, so a wait for something that never changes reads as a passing check. Worth
suspecting whenever a group's wall time doesn't match the work it appears to do.

### 7. `setExperimentName` / `renameFile` still slept

Two of the last fixed sleeps outside the deliberate set, at 350 ms and 250 ms a call across
12 call sites in 6 groups. Both are now waits on the controlled field having rendered the typed
text back, which is also the more correct thing to wait for: blurring before that render commits
whatever the *previous* render held.

### 8. A wait that gives up now fails the run

The two findings above (§6, and the 10 s one in §9) were the same bug twice: a wait for something
that could never happen, behind a check that passed anyway. Neither was visible in the output —
`waitValue` and `waitStable` return the stale value instead of throwing, precisely so the `check`
after them can report what it saw, and that made a permanently-expiring wait indistinguishable
from a fast one.

They still return. But the timeout is now **recorded** (`harness.mjs`'s `softTimeouts`), and
`uitest` turns each record into a failed check at the end of the run. `tabBecomes`, which caught
and discarded its own timeout, records one too. There is no opt-out: a wait allowed to expire
quietly is exactly how both of these survived.

`clickTab` lost its 2 s tolerance in the process. It was there for "callers that click a tab to
show it is disabled" — no caller does that; they read the tab's `disabled` state instead.

**This immediately found two live flakes**, both of which had been costing 8 s and passing:

- **the Reference cold deep link.** `coldLoad` waited for the view bar, which is drawn before the
  named file is hydrated — so a 400 KB parse ran inside `tabBecomes`' 8 s clock instead of before
  it. It waits for the file's chip now. (The doc comment above `coldLoad` had already diagnosed
  this exact failure; the fix it describes had not been applied.)
- **`cloneChecks` writing `location.hash` to leave the Instrument view.** The app writes the hash
  itself while settling into a view, so a write landing in that window is overwritten and the view
  snaps back — the failure mode `AGENTS.md` describes as "a hash write plus `tabBecomes` is not a
  navigation". It uses `clickTab` now.

### 9. The sleep audit

31 fixed sleeps down to **12**, and the ones left are all deliberate:

| kept | why |
|---|---|
| 5 × `flushWrites` + 200 ms | the flush is started, not awaited, and the app exposes no "pending writes" state to poll. Bounded and short — not a rate limit. |
| 5 × negative assertions | nothing is going to happen, so there is nothing to wait for. Includes the 5 s echo-suppression check, which must outlast a full 3 s disk-write window. |
| 1 × drag pacing | the gap *is* the simulation: a burst of mouse moves in one tick coalesces into a jump that never exercises the drag's intermediate frames. |

What went, and what replaced it:

- **"nothing on screen changes, so there is no observable"** was wrong three times over. Closing a
  file, renaming one and committing a clone all write IndexedDB, which a check can read — a
  `catalogNames(cdp)` helper now does, replacing three sleeps and two hand-rolled copies of the
  same query.
- **Two `Page.reload` + `sleep(600)` pairs** were followed immediately by a `waitFor` on the chip.
  Pure dead time.
- **Four `about:blank` navigations** each slept 200 ms; `navigateBlank` waits for `location.href`.
- **`renameProto`** was a byte-identical copy of `renameFile`, sleeps and all. Deleted.
- **Hover, double-click and mode-switch sleeps** all had observables sitting next to them — the
  peeked-cell count, the selected-well count, the active segmented item.

## Where the remaining 55 s goes

Per-group totals, measured in place (33 groups, all 340 checks green):

| group | s |
|---|---|
| disk folders | 9.4 |
| load from URL | 6.1 |
| password handling | 3.0 |
| instrument runs and experiments | 2.2 |
| XML rendering | 2.1 |
| open files and the selection | 2.1 |
| close confirmation | 1.9 |
| thermal profile | 1.7 |
| entry storage | 1.6 |
| curves chart (dragging a Cq marker) | 1.6 |

The tail is flat: the remaining 23 groups are all under 1.6 s. What is left is mostly irreducible
— page loads, file parses and React renders, plus ~4 s of startup (`tsup` build, Vite, Chrome) and
the deliberate sleeps above.

`disk folders` is still the largest, but over half of what remains is the 5 s echo-suppression
sleep, which has to stay. `load from URL` is second and is genuinely doing the work: it is the
only group that cold-loads the app five times over, each one a full document load plus a 400 KB
parse.

> **Historical note.** An earlier version of this table listed `experiment names` at 29.7 s and
> was read for a long time as "naming a run is expensive". It was not: those were the *original*
> per-group minimums on `8ddad14`, before §1, and nearly all of that 29.7 s was the tab leak's
> `deleteDatabase` stall landing on this group's `emptyReload`. Measured in place afterwards the
> group is **2 s**. A before-table left sitting under an after-heading sent one investigation
> chasing a cost that had been fixed a year of commits earlier — hence the numbers above are
> re-measured rather than carried forward.

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

### Not done: unit tests for the write throttle

`WriteThrottle` takes a `now()` override that is commented "Overridable for tests", and there are
no tests. `apps/web` has no test runner at all — every unit test in the repo lives in
`packages/core`. The rate limiter's contract (first edit immediate, later ones coalesced into one
trailing write, a throwing `write` re-arming) is exactly the sort of thing that belongs in a fast
unit test rather than in a browser, and today it is only covered incidentally, through the one
`folderChecks` case above. Standing up a Vitest project for `apps/web` is its own piece of work.
