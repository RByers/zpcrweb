# AGENTS.md

## What belongs in this file

This file holds **only critical, agent-specific instructions** — how an agent should behave when
working in this repo. Information *about* the project — what it is, what files and formats exist,
what commands humans and agents run, how the app's URLs work — belongs in
[`README.md`](./README.md), the `ARCHITECTURE.md` files, and the format docs README indexes.

Before adding anything here, ask: is this an instruction to an agent, or information about the
project? If it's the latter, write it in README.md (or the relevant doc) and, at most, point to it
from here. Keep this file short enough that reading it in full every session stays cheap.

Start by reading [`README.md`](./README.md): project overview, repository layout, commands, the
reverse-engineered format-doc index, the UI tooling, and the web app's URL-hash keys.

## Where agent configuration lives

Agent config is vendor-neutral: instructions in `AGENTS.md` files, skills in `.agents/skills/`.
Vendor-specific paths are thin pointers at those, never copies — `CLAUDE.md` is a stub whose only
content is an `@AGENTS.md` include, and `.claude/skills` is a symlink to `.agents/skills`. Add a
new skill under `.agents/skills/<name>/SKILL.md`; nothing under `.claude/` needs to change.

## Git workflow

**No pull requests in this repo, and history is always linear** — no merge commits, ever. Development
is done locally, with worktrees branched from local `main`, and fast-forwarded into `main` when done.
The operator does manual testing and pushes upstream to deploy live when good, never the agent.

- Create worktrees on branches forked from the local `main` branch and do development there.
- After a worktree is created, double check that it's up to date with local `main` and rebase if
  necessary to prevent working on stale code.
- Copy the local `secrets.json` into the worktree after creation. It's .gitignored to keep
  secrets out of the repo, but necessary for passing some tests.
- When work is complete, rebase the branch onto `main` and verify that tests pass.
- Typecheck too, before committing — `npm run typecheck` covers only core, so a change under
  `apps/web` needs `npm run typecheck -w @zpcrweb/web` as well. `npm test` passes happily on
  code that doesn't compile, which is how a type error reached `main` in the first place.
- Then exit the worktree and land it on main with `git merge --ff-only <branch>`, then delete
  the worktree and branch.
- After landing, report the size of what was just merged as lines added and removed, split five
  ways — core, core tests, UI, UI tests, docs — so the operator can see at a glance how much
  production code moved versus test code versus prose. Run it over the commits that landed
  (`git diff --numstat <old-main>..main`, where `<old-main>` is `main`'s tip before the merge —
  `main@{1}` normally works):

  ```sh
  git diff --numstat main@{1}..main | awk '
    $3 ~ /^packages\/core\/test\//          {c="core tests"}
    $3 ~ /^packages\/core\/src\//           {c="core"}
    $3 ~ /^tools\/(uitest|uishot|harness)\.mjs$/ {c="UI tests"}
    $3 ~ /^apps\/web\/src\//                {c="UI"}
    $3 ~ /\.md$/                            {c="docs"}
    c=="" {c="other"} {a[c]+=$1; d[c]+=$2; c=""}
    END {for (k in a) printf "%-11s +%d / -%d\n", k, a[k], d[k]}'
  ```

  "UI tests" is the browser harness in `tools/` (`uitest.mjs`, `uishot.mjs`, `harness.mjs`), since
  that is where the web app's tests actually live. "docs" is every `*.md` wherever it sits — the
  format docs at the root, the `ARCHITECTURE.md` files inside `apps/` and `packages/`, this file —
  which is why its rule comes last and overrides the directory rules above it. Everything else —
  config, other `tools/` scripts — falls into "other"; keep that row, it is the honest remainder.
  Report the five categories even when a row is zero, so a commit that touched no tests says so
  plainly.
- If the fast-forward fails, the branch has fallen behind — rebase it again. Never reach for
  `--no-ff` or `-m` to get unstuck, and never rebase commits already reachable from `origin/main`.
- Don't open PRs, and don't create branches on `origin`. Pushing `main` to `origin` is a deploy
  step the user performs by hand after a round of manual testing — don't push, and never
  force-push.
- History before `034a68a` (2026-07-24) still contains 14 merge commits from the old merge-based
  flow. Leave them alone: rewriting them would rewrite 100+ already-pushed commits for purely
  cosmetic gain.

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

## Writing user-visible text

**Never cite a repo file from the UI.** No `alf.md §7.6`, no `threshold.md §5`, no source
filenames — not in body copy, headings, tooltips, empty states or error messages. The person
reading the app has a thermocycler and a run that matters to them; they do not have this
repository, so a section number is a dead end that makes the app look like it is talking to its
own authors. Say the thing instead: *"the `.alf` run report stored with this run"*, not
*"the run report (alf.md §7.6)"*.

File **extensions** and instrument-facing names are fine and often the clearest thing to say —
`.alf`, `.Plateread`, `.prcl.txt`, `PLATEREAD` — because those are the user's own files and their
instrument's own vocabulary, not ours.

The provenance the citation was carrying is still worth keeping: put it in a code comment beside
the text, where whoever maintains the component will find it, and let the format doc go on being
the authority. That is the same split the docs themselves use — rule in the main text, derivation
in an appendix.

## Raw views show everything

**A raw view shows absolutely everything the file contains, in exactly the detail the file holds
it in. Every other view is prettified and simplified to be useful.** Applies to every format and
every decoded raw renderer, without exception: don't drop a field for being empty, don't drop one
for being uninterpretable, and if core doesn't parse a field yet, add it to core rather than
leaving a hole in the view. Adding to a file's contents — naming fields, joining a row to what
explains it, deriving what the file implies but never states — is always fine; subtracting is not.
`apps/web/ARCHITECTURE.md` ("Raw views") has the reasoning and the worked example.

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

It takes ~100s and needs Chrome, so it is deliberately **not** part of `npm test`. Run it when you
touch `state/urlHash.ts`, `state/useHeaderFit.ts`, `state/pltdPassword.ts`,
`components/curves/ChipBar.tsx`, `components/curves/CurveTable.tsx`, `components/curves/CqRange.tsx`,
`components/curves/CurveChart.tsx` or `components/curves/ThresholdSection.tsx` (or `lib/uplot/chart.ts`'s
Cq markers — the rings are drag handles for a curve's threshold),
`components/instrument/InstrumentRun.tsx`, `state/useRunStaging.ts`, `state/useRunNaming.ts`,
`components/instrument/InstrumentRail.tsx`, `state/fileContent.ts` (or `state/db.ts`'s
`StoredFile`, or `useZpcrStore.ts`'s `addRunArchive`),
`state/diskFolders.ts`, `state/useDiskTree.ts`, `components/FolderSection.tsx` or
`components/DropZone.tsx` (the disk-backed folder route — and note the picker itself cannot be
driven from CDP, so `folderChecks` substitutes an OPFS directory for it),
`lib/samples.ts`, `apps/web/vite.config.ts`'s samples plugin or `App.tsx`'s welcome-screen test
(the bundled `samples` folder — `sampleFolderChecks`),
`state/useCfxDevice.ts`'s `cancelRun`/`setRunPaused`
(or core's `usb/device.ts` `cancelRun`), `lib/protocolSource.ts`,
`lib/experiment.ts` (or core's `experiment.ts`), `components/ViewSelector.tsx` or `App.tsx`'s
`enabledViewsFor`/`selectFile`, core's `runDefinition.ts`, `components/raw/DecodedView.tsx`'s
`ProtocolDecoded`, `components/views/StandaloneProtocolView.tsx`, `components/FileBar.tsx`,
`components/FilesTableView.tsx` or `components/CloseFileButton.tsx` (closing a file is what removes
it from IndexedDB — see `useZpcrStore.ts`'s `closeFile`),
`components/FileIcons.tsx` (or core's `fileKind.ts`), `components/views/StandaloneRawView.tsx`,
`components/protocol/` (the protocol editor) or core's `protocolBuilder.ts`,
`components/plate/PlateEditor.tsx`, `components/plate/PlateEditPanel.tsx`,
`components/plate/usePlateSelection.ts`, `components/plate/PlateViewer.tsx`'s selection props,
`state/useZpcrStore.ts`'s `setPlateText` or core's `plateEdit.ts`/`plateClipboard.ts`,
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
