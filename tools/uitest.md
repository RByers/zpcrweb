# `uitest.mjs`

Headless-Chrome browser assertions for the behavior nothing else can catch: the core Vitest suite
has no DOM, and a screenshot has no interaction. Everything checked here is a real regression risk
that otherwise fails silently.

## Usage

```sh
npm run test:ui
node tools/uitest.mjs
```

Exits non-zero on any failure. It takes ~100s and needs Chrome, so it is deliberately **not** part
of `npm test` — the core suite is dependency-free and runs in seconds.

## What it covers

URL-hash routing and back/forward, password handling (including that the secret never lands in the
address bar), the rail chips' interaction contract, the Curves table's sort and filter behavior,
threshold drag handles and Cq markers, the protocol editor's click-to-edit / insert / delete / undo
contract, the plate editor's selection and clipboard behavior, the `.alf` run report's derived
columns, run staging and naming, view selection per file kind, file closing and IndexedDB cleanup,
and the disk-backed folder route — whose directory picker cannot be driven from CDP, so an
origin-private (OPFS) directory stands in for it.

`AGENTS.md`'s "UI testing" section carries the authoritative list of source files that should make
you run this; keep that list current when you add a check here.

## Writing a check

The rules live in `AGENTS.md` ("Don't write a fixed `sleep` into a check"); the vocabulary they are
written in lives in [`harness.md`](./harness.md). In short: wait for the state you are about to
assert on, never for a number of milliseconds. A fixed `sleep` is right for exactly one thing — a
**negative** assertion, where nothing happened and there is no state change to wait for — and it
should say so in a comment.

Two details that have bitten this suite before:

- **Rail hover ("peek") needs a real `Input.dispatchMouseEvent`.** React derives
  `onMouseEnter`/`onMouseLeave` from an over/out pair plus `relatedTarget`, so a synthesized
  `mouseover` silently does nothing.
- **Rate-limited writes need `flushWrites`, not patience.** The app writes to storage behind a
  throttle of up to 60s; `flushWrites` hides the page and puts it straight back, so the flush a
  real backgrounded tab gets is the one the test gets. Exactly one check — "an edit in the app is
  written back to the real file on disk", in `folderChecks` — waits out the real timer on purpose,
  to prove the timer fires at all. Leave that one slow.

Fixtures that only exist to be a shape (a `.prcl.txt` the editor can hold, a plate CSV, a duplicate
of a sample under a different size) are written at test time under `tools/.uishot/`, not committed:
the point is the text form this app writes, not a captured artifact.

## Requirements

Node, the system Chrome, and the samples in `samples/`. It also needs `cfxPassword` in the
gitignored `secrets.json` — the password checks can't run without it, so the script says so and
exits rather than pretending to pass. In a fresh worktree, copy `secrets.json` in by hand; it is
gitignored, so a new checkout won't have one.

Before anything is spawned it runs `buildCore()`, so a stale `packages/core/dist/` surfaces here
with a real reason rather than hundreds of checks later as a missing export.
