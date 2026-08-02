# CLAUDE.md

## What belongs in this file

CLAUDE.md holds **only critical, agent-specific instructions** — how an agent should behave when
working in this repo. Information *about* the project — what it is, what files and formats exist,
what commands humans and agents run, how the app's URLs work — belongs in
[`README.md`](./README.md), the `ARCHITECTURE.md` files, and the format docs README indexes.

Before adding anything here, ask: is this an instruction to an agent, or information about the
project? If it's the latter, write it in README.md (or the relevant doc) and, at most, point to it
from here. Keep this file short enough that reading it in full every session stays cheap.

Start by reading [`README.md`](./README.md): project overview, repository layout, commands, the
reverse-engineered format-doc index, the UI tooling, and the web app's URL-hash keys.

## Git workflow

**No pull requests in this repo, and history is always linear** — no merge commits, ever. Work is
committed onto worktree branches and fast-forwarded into `main`.

- Create worktrees on branches forked from the local `main` branch and do development there.
- When work is complete, rebase the branch onto `main` and verify that tests pass.
- Typecheck too, before committing — `npm run typecheck` covers only core, so a change under
  `apps/web` needs `npm run typecheck -w @zpcrweb/web` as well. `npm test` passes happily on
  code that doesn't compile, which is how a type error reached `main` in the first place.
- Then land it with `git merge --ff-only <branch>`. After doing so delete the worktree and branch.
- If the fast-forward fails, the branch has fallen behind — rebase it again. Never reach for
  `--no-ff` or `-m` to get unstuck, and never rebase commits already reachable from `origin/main`.
- Don't open PRs, and don't create branches on `origin`. Pushing `main` to `origin` is a deploy
  step the user performs by hand after a round of manual testing — don't push, and never
  force-push.
- History before `034a68a` (2026-07-24) still contains 14 merge commits from the old merge-based
  flow. Leave them alone: rewriting them would rewrite 100+ already-pushed commits for purely
  cosmetic gain.

### Worktree base ref

`origin` here is a personal deploy target, not a shared upstream — `main` is pushed only after a
round of manual testing (see above), so between deploys `origin/main` lags behind local `main`,
sometimes by a lot. `.claude/settings.json` sets `worktree.baseRef` to `"head"` so `EnterWorktree`
branches from local `HEAD` (i.e. local `main`, when that's checked out) instead of the default
`"fresh"` behavior, which branches from `origin/<default-branch>`. Without this, a new worktree
ends up dozens of commits behind local `main`; merging it back is still a clean fast-forward, but
`ExitWorktree`'s cleanup then refuses to delete the worktree branch, since from its point of view
it looks like a branch with many commits not yet reachable from `main` (Git only sees that
`origin/main` isn't an ancestor of `main` — it doesn't check whether those commits are old history
that's actually already merged into `main`). If you ever see a new worktree start dozens of commits
behind local `main`, check that `.claude/settings.json` hasn't been lost.

This means `ExitWorktree`'s "N commits, confirm before discarding" refusal is a structural false
positive for every worktree branch in this repo, not a real signal of unmerged work — once
`git merge --ff-only <branch>` has actually succeeded onto local `main`, it's safe to call
`ExitWorktree` with `action: "remove", discard_changes: true` directly, without waiting for the
refusal first. Only treat the refusal as real if the ff-merge failed or wasn't attempted.

If a worktree ever does end up branched from `origin/main` instead of local `main` (e.g.
`.claude/settings.json`'s `worktree.baseRef` got lost, or the worktree was created some other
way), rebase it onto local `main` before starting work on it, rather than developing on top of
the stale base — otherwise the eventual `git merge --ff-only` will fail once `main` has moved on,
and unwinding that after work has piled up is more disruptive than rebasing up front.

### Local secrets in a worktree

`secrets.json` is gitignored (see "Secrets" below), so a fresh worktree checkout doesn't have
one even though the main checkout does — a worktree is a separate working directory, and
gitignored files aren't part of what Git copies into it. Copy it in right after creating the
worktree (`cp /Users/rbagent/code/zpcrweb/secrets.json <worktree>/secrets.json`) whenever the
work might touch encryption-dependent code paths — `npm test`'s `describe.skipIf(!PW)` blocks
and `tools/uitest.mjs`/`tools/zpcr.mjs`'s password fallback silently degrade without it, which
can look like a passing run that actually skipped real coverage.

### Local git config

The linear-history workflow above is enforced by repo-local git config (`.git/config`, so it is
not committed and must be re-applied on a fresh clone):

```sh
git config --local pull.rebase false   # override a global pull.rebase=true
git config --local pull.ff only        # a pull may only fast-forward, never rewrite history
git config --local merge.ff only       # `git merge <worktree-branch>` fails unless it ff's
git config --local merge.conflictStyle zdiff3  # conflict markers include the common ancestor
git config --local rerere.enabled true # remember conflict resolutions
git config --local rerere.autoupdate true
```

`merge.ff = only` is what actually keeps history linear: if a worktree branch has fallen behind,
the merge errors out instead of silently creating a merge commit, so you rebase it first.

`pull.rebase = false` is load-bearing rather than redundant: `pull.rebase` outranks `pull.ff`, so
without the local `false` a global `pull.rebase = true` would win and `pull.ff = only` would never
take effect. Together they mean a `pull` can only fast-forward, and otherwise fails — it will
never quietly rewrite local history.

`merge.conflictStyle = zdiff3` adds the common-ancestor text to conflict markers, which makes the
doc-heavy conflicts this repo produces much easier to resolve. Conflict style feeds the hashes
rerere uses to recognize a conflict, so changing it later invalidates everything already learned
in `.git/rr-cache`; leave it as-is.

## Keeping documentation current

- Whenever changes are made, review and update all `ARCHITECTURE.md` files to be a concise yet
  accurate summary of the application design, with pointers to other relevant files.
- The format docs (indexed in README.md) are the reference for anything in `packages/core/src`
  that touches raw bytes — **read the relevant doc before changing a decoder, and update it in
  the same commit as the decoder change.**
- Renumbering a doc's sections means updating everything that cites them in the same commit:
  `grep -rn '<doc>.md'` finds the references, and bare `§N` mentions in nearby prose too.
- A directory of standalone, independently-usable pieces (currently `tools/`) gets its own
  `README.md` indexing what each one is for — one row per file, short enough to scan, pointing
  into the file's own header comment for detail rather than duplicating it. Add the new entry in
  the same commit that adds the file, and update the row in the same commit that changes what a
  file does. The root `README.md` links to it rather than re-listing the contents, the same way
  it points at `ARCHITECTURE.md` and the format docs instead of inlining them.

### Writing documentation

These docs are read by someone deciding whether to trust or change the code, so they are written
for clarity first. What that means here, and what to preserve when editing one:

- **Open with the problem, not the mechanism.** State what question the code answers and why the
  answer isn't obvious from the inputs, before any formula. A reader who stops after §1 should
  still know what the thing is for.
- **Main text = what the code does today.** Present tense, plainly, in the order the pipeline
  runs. One idea per section, with the entry point and the file that implements it named.
- **Relegate provenance.** How a rule was derived — the measurements, the byte-level spelunking,
  the comparisons against reference output — belongs in an appendix, referenced from the rule.
  The rule itself gets one line saying *measured*, *read from the file*, or *this library's own*,
  because that distinction is what tells a reader which numbers are safe to change.
- **Keep the failures, out of the way.** Rejected alternatives and the pathological inputs that
  killed them are valuable — they stop the same idea being re-proposed — but they are a separate
  appendix, never an aside in the middle of the algorithm.
- **Mark future work where it is relevant** with a short inline `> **Future:** …` callout, and
  collect the full list in one section near the end. Distinguish *deliberately not implemented*
  from *genuinely unknown*.
- **Prefer a table or a short pseudocode block to a paragraph** when the content is a mapping or
  a procedure. Quantify: "within 0.11 cycles", not "close enough".
- **Number sections and reference them from the code** (`threshold.md` §5.2), which is how a
  constant in a source file stays tied to its justification.

## Secrets

Local-only secrets (the CFX file decryption password) live in `secrets.json`, which is gitignored
and never committed. Never commit it, print it into a transcript, or put it anywhere but a
`#cfxPassword=` URL fragment (URL-escape it — it can contain characters like `#`). Only tests that
exercise the decryption pipeline need it (`describe.skipIf(!PW)` blocks); everything else runs
against the plaintext samples in `samples/`, so a missing `secrets.json` is never a reason to stop.

## UI testing

Use your judgment about how much UI testing a change warrants — the goal is to stay fast and
productive, with good tools available for when checking is actually worth it. A CSS tweak or a
label change doesn't need a browser. A change to layout, charts, view switching or state handling
usually does. When in doubt, one `uishot` run is cheap enough that it's not worth agonizing over.

README.md describes what `tools/uishot.mjs` and `tools/uitest.mjs` are and what they cover; the
rules for *using* them are here.

### `tools/uishot.mjs` — look at it

Read the **single labelled contact sheet** it writes; don't take per-view screenshots, and capture
every view you touched in one run. Controlling what it costs:

- **The text report is nearly free** — `console clean` vs. a `PROBLEMS` list is often all you
  need, and a run whose report is clean and whose diff is small may not need the image at all.
- **`--max-width` trades legibility for tokens** (image cost ≈ w×h/750). The 1400px default is
  legible for layout, spacing and chart rendering. Drop to `--max-width 900` for a quick "is it
  broken" check; raise it only when judging fine typography.
- Skip it entirely for pure logic/decoder changes that render nothing.

### `tools/uitest.mjs` (`npm run test:ui`) — assert it

It takes ~35s and needs Chrome, so it is deliberately **not** part of `npm test`. Run it when you
touch `state/urlHash.ts`, `state/useHeaderFit.ts`, `state/pltdPassword.ts`,
`components/curves/ChipBar.tsx`, `components/curves/CurveTable.tsx`, `components/curves/CqRange.tsx`,
`components/instrument/InstrumentRun.tsx`, `state/useRunStaging.ts`, `state/useRunNaming.ts`,
`components/instrument/InstrumentRail.tsx`, `state/useCfxDevice.ts`'s `cancelRun`/`setRunPaused`
(or core's `usb/device.ts` `cancelRun`), `lib/protocolSource.ts`,
`lib/experiment.ts` (or core's `experiment.ts`), `components/ViewSelector.tsx` or `App.tsx`'s
`enabledViewsFor`/`selectFile`, core's `runDefinition.ts`, `components/raw/DecodedView.tsx`'s
`ProtocolDecoded`, `components/views/StandaloneProtocolView.tsx`, `components/FileBar.tsx`,
`components/FileIcons.tsx` (or core's `fileKind.ts`), `components/views/StandaloneRawView.tsx`,
`components/protocol/` (the protocol editor) or core's `protocolBuilder.ts`,
`components/raw/DecodedAlf.tsx`, `components/protocol/ThermalProfileChart.tsx`,
`lib/uplot/thermalChart.ts`, `components/views/ProtocolView.tsx` or core's `alf.ts`,
`components/views/OverviewPanel.tsx`, `components/views/OverviewPlateSection.tsx`,
`components/views/OverviewView.tsx`'s completeness banner or core's `runCompleteness`/
`expectedPlateReads`,
`lib/cloneName.ts` or `App.tsx`'s `cloneActiveFile`,
core's `runSeed.ts` or `App.tsx`'s `runViews`, `state/useRunWatch.ts`,
`state/writeThrottle.ts`, `state/useZpcrStore.ts`'s
`modifiedIds`/`markDownloaded`/`setProtocolText`, its settings seeding or `fileKind`, or
view selection.

Both tools share `tools/harness.mjs` (the CDP client and dev-server/Chrome plumbing); **add new
checks there rather than starting a third script.** Note that rail hover ("peek") needs a real
`Input.dispatchMouseEvent` — React derives `onMouseEnter`/`onMouseLeave` from an over/out pair
plus `relatedTarget`, so a synthesized `mouseover` silently does nothing.

### When to use the MCP instead

Reach for the **chrome-devtools MCP** when you need to *interact* — hover cards, drag, multi-step
flows, or debugging why something is broken. Its accessibility snapshot and live console are worth
the extra tokens for exploration; the two tools above cover the check-your-work pass. The MCP isn't
available in every environment (background jobs, restricted accounts) — `uishot`/`uitest` need
nothing but Node and the system Chrome, so prefer them when both would work.

**Always launch Chrome headless** (`--headless=new`), whichever route you take. This account has no
interactive desktop session, so a headful Chrome has no display to open a window on — it will hang
or fail rather than showing anything, and nobody is watching a screen for it anyway. If the MCP is
configured to launch headful, pass it a headless option rather than working around the hang.

Other flags that matter when driving Chrome by hand: use a random port (never 5173 — the user may
have a dev server running there), set `CHROME_PATH` if Chrome isn't at
`/Applications/Google Chrome.app`, and pass `--disable-component-update
--disable-background-networking`. Without those two, Chrome's auto-updater spawns a child that
holds stdout open and the run looks like a hang long after the page is done.

### Getting a sample file loaded

Use CDP's `DOM.setFileInputFiles` against the app's own `<input type="file">` — this is what
`uishot` does, and it's both the cheapest and the most faithful option:

- **Zero tokens.** It happens inside the script; nothing about the file enters the transcript.
- **It exercises the real code path** — the same `addFiles` → validate → IndexedDB flow a user
  triggers by dropping a file, so a regression in loading actually fails the check.
- **No production code exists just for testing.** Nothing to ship, nothing to keep in sync.

Rejected alternatives, so they don't get re-proposed:

- *Seeding IndexedDB directly via `Runtime.evaluate`* — pushes megabytes of base64 through a CDP
  message, and skips the validation/parse path entirely, so it can "pass" on a file the app cannot
  actually open.
- *A `?sample=` parameter that fetches from the dev server* — ships test-only code to production,
  and `samples/` sits outside the Vite root so it isn't served anyway.
- *Synthesizing drag-and-drop `Input` events* — fiddly and flaky for no gain over the file input.

Default to `samples/20260720_FirstQualification.zpcr` (~400 KB): it has real amplification curves,
targets, samples and calibration data, so every view renders something meaningful. The ~70 KB
samples load marginally faster but leave views sparse, which makes them poor screenshot subjects.
Each run starts from a clean Chrome profile — otherwise a previous run's sample lingers in
IndexedDB and shows up as an extra file chip.
