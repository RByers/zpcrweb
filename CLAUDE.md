# CLAUDE.md

## Git workflow

**No pull requests in this repo, and history is always linear** — no merge commits, ever. Work is
committed onto worktree branches and fast-forwarded into `main`.

- Create worktrees on branches forked from the local `main` branch and do development there.
- When work is complete, rebase the branch onto `main` and verify that tests pass.
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
ends up dozens of commits behind local
`main`; merging it back is still a clean fast-forward, but `ExitWorktree`'s cleanup then refuses
to delete the worktree branch, since from its point of view it looks like a branch with many
commits not yet reachable from `main` (Git only sees that `origin/main` isn't an ancestor of
`main` — it doesn't check whether those commits are old history that's actually already merged
into `main`). If you ever see a new worktree start dozens of commits behind local `main`, check
that `.claude/settings.json` hasn't been lost.

This means `ExitWorktree`'s "N commits, confirm before discarding" refusal is a structural false
positive for every worktree branch in this repo, not a real signal of unmerged work — once
`git merge --ff-only <branch>` has actually succeeded onto local `main`, it's safe to call
`ExitWorktree` with `action: "remove", discard_changes: true` directly, without waiting for the
refusal first. Only treat the refusal as real if the ff-merge failed or wasn't attempted.

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

Whenever changes are made, review and update all ARCHITECTURE.md files to be a concise yet accurate summary of the application design, with pointers to other relevant files.

## Secrets

Local-only secrets (the CFX file decryption password) live in `secrets.json`, which is
gitignored and never committed — `{ "cfxPassword": "…" }`. Tests load it via
`packages/core/test/secrets.ts`; only tests that explicitly exercise the decryption pipeline
need it (`describe.skipIf(!PW)` blocks) — everything else runs against the plaintext samples
committed in `samples/` — each encrypted sample's decrypted payload sits beside it as
`<name>.xml`, so the structural tests never touch the crypto.

## UI testing

Use your judgment about how much UI testing a change warrants — the goal is to stay fast and
productive, with good tools available for when checking is actually worth it. A CSS tweak or a
label change doesn't need a browser. A change to layout, charts, view switching or state
handling usually does. When in doubt, one `uishot` run is cheap enough that it's not worth
agonizing over.

There are two tools, for two different jobs.

### `tools/uishot.mjs` — look at it

One command, ~5s, ~1–2k tokens:

```sh
node tools/uishot.mjs                                   # Overview + Curves, default sample
node tools/uishot.mjs --views curves                    # one view, biggest and most legible
node tools/uishot.mjs --views overview,curves,plates,raw # four views in one sheet
node tools/uishot.mjs --file samples/20260720_Luna_noRT.pcrd --views overview
```

It boots its own dev server and headless Chrome on random ports (so it never collides with the
server the user is running on 5173), loads a sample, walks the views, and writes **one labelled
contact-sheet PNG** — `tools/.uishot/shot.png` by default. Read that single image; don't take
per-view screenshots. It also reports console errors, uncaught exceptions and failed page
loads, which catch breakage a screenshot can't show.

Cost control, when you do run it:

- **Fewer, bigger images.** Views are tiled into one sheet, so 4 views cost one image (~2k
  tokens), not four. Capture every view you touched in a single run.
- **The text report is nearly free** — `console clean` vs. a `PROBLEMS` list is often all you
  need, and a run whose report is clean and whose diff is small may not need the image at all.
- **`--max-width` trades legibility for tokens** (image cost ≈ w×h/750). The 1400px default is
  legible for layout, spacing and chart rendering. Drop to `--max-width 900` for a quick "is it
  broken" check; raise it only when judging fine typography.
- Skip it entirely for pure logic/decoder changes that render nothing.

### `tools/uitest.mjs` — assert it

```sh
npm run test:ui
```

82 browser assertions covering what nothing else can catch: the two URL contracts — hash
routing (deep links, back/forward, unknown-file and invalid-view fallbacks) and password
handling (stripped from both URL forms, never leaked into the routing hash, an encrypted
`.pcrd` still decrypting) — plus `#load=`, the rule that every XML view uses the shared
collapsible tree rather than a flat dump, the chart's one-right-axis invariant
(temperatures and LED currents can never both be on), the Calibration view's default
selection (only the run's in-use `.Dcal` files of the 28 it ships, the rest a click away),
and the rail chips' shared interaction contract (double-click solos, hovering a disabled chip
peeks at it only while hovered) plus the Reference view's overlay toggles and x-axis modes —
including that hiding the factory line doesn't break the ΔRFU baseline computed from the same
values, and that its min/max bands draw under that baseline but drop out (with a note) on the
column axis, where a point is a run mean with no spread of its own — and the Curves table's sort contract (a header click re-orders, a second reverses,
Well sorts by plate position rather than label text, wells with no Cq stay at the bottom in
both directions) and its Cq axis (every marker at its own cycle, an empty axis where there is
no Cq) and its End RFU column (sorts numerically, and is a number of its own rather than a copy
of ΔRFU) — and the rail's Cq range filter, whose top stop is where the curves with no Cq live
(an upper bound drops them, the *lower* handle parked there leaves only them, and the handles
clamp instead of crossing) — and that a `.pcrd` carrying a hand-set threshold seeds it as a
per-fluorophore override while a dye the file left on auto is left alone (`threshold.md` §5.3:
that one value is what makes the app reproduce CFX's own Cq). A screenshot
can't show that the back button works, that a secret reached the address bar, that a hover
put a curve back, or that eight rows are in the right order — and the core Vitest suite has no
DOM.

Takes ~35s and needs Chrome, so it is **not** part of `npm test` — that stays fast and
dependency-free. Run it when you touch `state/urlHash.ts`, `state/pltdPassword.ts`,
`components/curves/ChipBar.tsx`, `components/curves/CurveTable.tsx`,
`components/curves/CqRange.tsx`, `state/useZpcrStore.ts`'s settings seeding, or view selection. Both
tools share `tools/harness.mjs` (the CDP client and dev-server/Chrome plumbing); add new checks there rather than starting a third
script. Note that rail hover ("peek") needs a real `Input.dispatchMouseEvent` — React derives
`onMouseEnter`/`onMouseLeave` from an over/out pair plus `relatedTarget`, so a synthesized
`mouseover` silently does nothing.

### When to use the MCP instead

Reach for the **chrome-devtools MCP** when you need to *interact* — hover cards, drag,
multi-step flows, or debugging why something is broken. Its accessibility snapshot and live
console are worth the extra tokens for exploration; the two tools above cover the
check-your-work pass. The MCP isn't available in every environment (background jobs,
restricted accounts) — `uishot`/`uitest` need nothing but Node and the system Chrome, so
prefer them when both would work.

**Always launch Chrome headless** (`--headless=new`), whichever route you take. This account
has no interactive desktop session, so a headful Chrome has no display to open a window on —
it will hang or fail rather than showing anything, and nobody is watching a screen for it
anyway. If the MCP is configured to launch headful, pass it a headless option rather than
working around the hang.

Other flags that matter when driving Chrome by hand: use a random port (never 5173 — the user
may have a dev server running there), set `CHROME_PATH` if Chrome isn't at
`/Applications/Google Chrome.app`, and pass `--disable-component-update
--disable-background-networking`. Without those two, Chrome's auto-updater spawns a child that
holds stdout open and the run looks like a hang long after the page is done.

### Everything is in the URL hash, nothing in the query string

- `#cfxPassword=<value>` seeds the decryption password so samples decrypt instead of sitting
  behind the prompt. Pull it from `secrets.json` (see Secrets, above) and URL-escape it — the
  password can contain characters like `#`.
- `#file=<name>&view=<overview|curves|plates|reference|calibration|raw|about>` selects the active file and
  view. `about` is the credits page behind the logo; it has no tab and needs no file.
- `#load=<url>` fetches a file and loads it — the only key that can put a file the browser
  doesn't already have into the app. It's consumed on load and replaced by the `#file=` the
  loaded file produces, so it never survives in the address bar. `apps/web/public/examples/`
  (a symlink to `samples/`) is what the welcome screen's "Load an example file" button loads,
  via this key.

Both are hash keys in one query string (`#cfxPassword=…&view=curves`), parsed by
`state/pltdPassword.ts` and `state/urlHash.ts`. **The password is in the fragment because it's
a secret**: fragments are never sent to the server, so they can't reach access logs, proxies,
or a `Referer` header — `?cfxPassword=` would reach all three. The app strips the password
from the address bar the moment it reads it, so a URL copied afterwards can be shared safely.
The legacy `?cfxPassword=` query form still works but is deprecated; don't write new links
with it.

### Getting a sample file loaded

Use CDP's `DOM.setFileInputFiles` against the app's own `<input type="file">` — this is what
`uishot` does, and it's both the cheapest and the most faithful option:

- **Zero tokens.** It happens inside the script; nothing about the file enters the transcript.
- **It exercises the real code path** — the same `addFiles` → validate → IndexedDB flow a user
  triggers by dropping a file, so a regression in loading actually fails the check.
- **No production code exists just for testing.** Nothing to ship, nothing to keep in sync.

Rejected alternatives, so they don't get re-proposed:

- *Seeding IndexedDB directly via `Runtime.evaluate`* — pushes megabytes of base64 through a
  CDP message, and skips the validation/parse path entirely, so it can "pass" on a file the
  app cannot actually open.
- *A `?sample=` parameter that fetches from the dev server* — ships test-only code to
  production, and `samples/` sits outside the Vite root so it isn't served anyway.
- *Synthesizing drag-and-drop `Input` events* — fiddly and flaky for no gain over the file
  input.

Default to `samples/20260720_FirstQualification.zpcr` (~400 KB): it has real amplification
curves, targets, samples and calibration data, so every view renders something meaningful. The ~70 KB samples
load marginally faster but leave views sparse, which makes them poor screenshot subjects. Each
run starts from a clean Chrome profile — otherwise a previous run's sample lingers in
IndexedDB and shows up as an extra file chip.

## Format documentation

The reverse-engineered binary format docs are the reference for anything in
`packages/core/src` that touches raw bytes — read them before changing a decoder. There's also
one algorithm doc, `calibration.md`, for the color-separation math built on top of `.Dcal`.

| Doc | Covers |
|-----|--------|
| [`icff.md`](./icff.md) | "ICFF" — the small index container format underlying both `.Plateread` and `.Dcal`: a trailing footer points at an index of `[name, offset, length]` entries. Implemented by `packages/core/src/icff.ts`; locate the index via the footer, not by scanning for a known field name. |
| [`plateread.md`](./plateread.md) | The `.Plateread` files inside a `.zpcr` — one per plate read (PCR cycle), holding the 6-channel × 108-well raw fluorescence table plus cycle number, block temperature and timestamp. **Mixed endianness:** metadata (version words, ICFF index) is big-endian; the WELLDATA/DARKDATA float arrays are little-endian. Implemented by `packages/core/src/plateread.ts`. |
| [`dcal.md`](./dcal.md) | The `.Dcal` pure-dye calibration files — per-dye, per-plate-type fluorescence response across all 6 channels at 4 block temperatures, plus a matching empty-plate baseline; the only in-archive source of the channel→dye mapping (`PRIMARYCHANNEL`). Unencrypted ICFF container. Implemented by `packages/core/src/dcal.ts`, entry point `parseDcal(bytes)`; `zpcr.calibrations()` decodes every `.Dcal` entry in an archive. |
| [`calibration.md`](./calibration.md) | Channel→dye color separation — the algorithm that turns raw per-channel readings plus `.Dcal` calibration data into per-dye concentration estimates. Not a file format doc. Implemented by `packages/core/src/calibration.ts` (linear algebra in `linalg.ts`), entry points `separateDyes()` (one-shot) and the individual `buildDyeResponseCurve`/`buildCalibrationMatrix`/`preprocessChannelReadings`/`separateChannels` stages. |
| [`threshold.md`](./threshold.md) | Baseline, threshold and Cq — how a per-dye amplification curve becomes a quantification cycle, or a reported non-amplification: baseline region selection, subtraction, threshold determination, the crossing rule, end-point RFU, and the app's controls over them. Not a file format doc. §1 states the problem; §3–§7 are the shipped algorithm, implemented by `packages/core/src/baseline.ts` (§3–§4, §7), `packages/core/src/threshold.ts` (§5–§6, entry point `computeCq()`) and `packages/core/src/analysis.ts` (`computeCqTable()`, the per-run entry point); §10 separates what is deliberately unimplemented from what is still unknown. **Appendix A is the measurement against CFX Manager's own exported results** for a committed sample — the Cq stage exactly (`packages/core/test/cfxExport.test.ts`), the baseline stage to within a cycle of window; Appendix B records the alternatives tried and how noisy curves broke them. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`prcl.md`](./prcl.md) | The `.prcl` thermal-cycling protocol files — lid/volume settings plus the ordered step list (hold, gradient, melt, goto, plate read), in the same encrypted-ZIP container as `.pltd`/`.pcrd`. The same `protocol2` XML document `.pcrd` embeds. Implemented by `packages/core/src/prcl.ts`, entry point `parsePrcl(bytes)`; `parseProtocol2()` is reused by `pcrd.ts`; `zpcr.protocols()` decodes every `.prcl` entry in an archive. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` CFX Manager saved-experiment file — the whole run (plate setup, protocol, every plate read, `RunInfo`/`runlog`, plus analysis/UI state) as one large XML document, in the same encrypted-ZIP container as `.pltd`/`.prcl`. Implemented by `packages/core/src/pcrd.ts`, entry point `parsePcrd(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr` produces. |
| [`zipcrypto.md`](./zipcrypto.md) | The single-entry ZipCrypto-encrypted ZIP container shared by `.pltd`/`.prcl` and `.pcrd`: container variants, the fixed shared password, and the decrypt → inflate pipeline. Implemented by `packages/core/src/zipcrypto.ts` + `inflate.ts`. |
| [`zpcrweb-json.md`](./zpcrweb-json.md) | `zpcrweb.json` — the one entry this project *writes* into a `.zpcr`, holding the run's analysis parameters (thresholds, the auto-threshold multiplier, calibration normalization) so they travel with the file instead of sitting in one browser's IndexedDB. Not reverse-engineered. Implemented by `packages/core/src/zpcrwebSettings.ts`; the app side is `apps/web/src/state/analysisSettings.ts` + `analysisPersist.ts`. |
| [`biomeme.md`](./biomeme.md) | Biomeme handheld device (Franklin/Two3/Three9) run-export JSON — the third input format, not a Bio-Rad format at all: no optical channels to unmix (fluorescence is per-dye already), and the device carries its own baseline/threshold/Cq alongside this library's. Self-describing JSON, not reverse-engineered. Implemented by `packages/core/src/biomeme.ts`, entry point `parseBiomeme(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr`/`parsePcrd` produce. |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Project-level design: isomorphic library goals, monorepo layout, input strategy. |
| [`apps/web/ARCHITECTURE.md`](./apps/web/ARCHITECTURE.md) | Web app design notes. |

`icff.md`, `plateread.md`, `dcal.md`, `pltd.md`, and `prcl.md` are marked **fully decoded** and
validated against the committed samples in `samples/` — though one `prcl.md` field (the
`PLATEREAD` operand) remains uninterpreted.
`pcrd.md`'s container, plate-read data, and `calibrationCollection` are likewise fully decoded
and cross-validated bit-for-bit against the matching `.zpcr`; `wellFactorsCollection` is decoded
too (it is the only source of the per-well gain factors `calibration.md` §4.1 needs), and the
remaining analysis-state subtrees (`dataAnalysisParameters`, `PersistedData`, …) are mapped but
not yet interpreted. If a decoder changes, update the corresponding doc in the same commit.

## Writing documentation

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
  constant in a source file stays tied to its justification. Renumbering a doc therefore means
  updating those references in the same commit — `grep -rn '<doc>.md'` finds them, and bare `§N`
  references in nearby prose too.

## Commands

```sh
npm install                     # install all workspaces
npm test                        # @zpcrweb/core Vitest suite
npm run build                   # build the library (ESM + CJS + .d.ts)
npm run typecheck               # typecheck the library
npm run dev -w @zpcrweb/web     # web dev server → http://localhost:5173
                                # hot-reloads packages/core edits too (aliased to src, no tsup watch)
npm run build -w @zpcrweb/web   # web production build (typechecks first)
```
