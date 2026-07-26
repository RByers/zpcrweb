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

## UI testing

When making non-trivial UI changes, use the chrome-devtools MCP to test in Chrome. Always start an independent chrome instance and dev server running on a unique random port to avoid conflicting with the dev sever the user may be running for the main branch. Try to balance token use and UI quality by not over-using chrome-devtools. 

## Secrets

Local-only secrets (the CFX file decryption password) live in `secrets.json`, which is
gitignored and never committed — `{ "cfxPassword": "…" }`. Tests load it via
`packages/core/test/secrets.ts`; only tests that explicitly exercise the decryption pipeline
need it (`describe.skipIf(!PW)` blocks) — everything else runs against the plaintext samples
committed in `samples/` and `packages/core/test/fixtures/`.

## UI testing

When testing the web app in a browser, always load it with the `cfxPassword` URL query
parameter set, so samples decrypt automatically instead of sitting behind the password prompt:
pull the value from `secrets.json`'s `cfxPassword` field (see Secrets, above) and append
`?cfxPassword=<value>` to the dev server URL with URL escaping in case of any special characters like # in the password, e.g. `http://localhost:5173/?cfxPassword=<value>`.

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
| [`threshold.md`](./threshold.md) | Baseline, threshold and Cq — how a per-dye amplification curve becomes a quantification cycle: smoothing, baseline region selection, baseline subtraction modes, threshold determination, and the two Cq algorithms (threshold crossing vs. curve-fit). Not a file format doc. Implemented by `packages/core/src/baseline.ts` (§2–§4) and `packages/core/src/threshold.ts` (§5–§7, entry point `computeCq()`); not yet validated against a reference instrument's own Cq. Grounded in the per-fluorophore analysis parameters a `.pcrd` persists. |
| [`pltd.md`](./pltd.md) | The `.pltd` plate-definition files — per-well fluorophores, target/gene, sample name and type, replicate, standard quantity. Encrypted + compressed XML container. Implemented by `packages/core/src/pltd.ts`, entry point `parsePltd(bytes)`; `zpcr.plates()` decodes every plate in an archive. |
| [`prcl.md`](./prcl.md) | The `.prcl` thermal-cycling protocol files — lid/volume settings plus the ordered step list (hold, gradient, melt, goto, plate read), in the same encrypted-ZIP container as `.pltd`/`.pcrd`. The same `protocol2` XML document `.pcrd` embeds. Implemented by `packages/core/src/prcl.ts`, entry point `parsePrcl(bytes)`; `parseProtocol2()` is reused by `pcrd.ts`; `zpcr.protocols()` decodes every `.prcl` entry in an archive. |
| [`pcrd.md`](./pcrd.md) | The `.pcrd` CFX Manager saved-experiment file — the whole run (plate setup, protocol, every plate read, `RunInfo`/`runlog`, plus analysis/UI state) as one large XML document, in the same encrypted-ZIP container as `.pltd`/`.prcl`. Implemented by `packages/core/src/pcrd.ts`, entry point `parsePcrd(bytes)`, which decodes into the same `Zpcr` shape `parseZpcr` produces. |
| [`zipcrypto.md`](./zipcrypto.md) | The single-entry ZipCrypto-encrypted ZIP container shared by `.pltd`/`.prcl` and `.pcrd`: container variants, the fixed shared password, and the decrypt → inflate pipeline. Implemented by `packages/core/src/zipcrypto.ts` + `inflate.ts`. |
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
