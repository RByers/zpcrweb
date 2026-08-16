# `harness.mjs`

The shared browser-automation library behind [`uishot.mjs`](./uishot.md) and
[`uitest.mjs`](./uitest.md). Not a script — nothing to run — but the place new browser-automation
checks belong, rather than a third tool.

It speaks the Chrome DevTools Protocol directly over Node's global `WebSocket`, so neither tool
needs Puppeteer or any other dependency: just Node and the system Chrome.

## The waiting vocabulary

A check should be written in these, never in a fixed `sleep` (see `AGENTS.md`, "Don't write a fixed
`sleep` into a check" — a sleep long enough to be safe on a loaded machine is dead time on every
run, and one short enough to be quick is a flake).

| Helper | Use it for |
|--------|-----------|
| `waitFor(fn)` | a condition became true. Throws on timeout, naming what it waited for. |
| `waitValue(read, pred)` | poll until the value satisfies `pred`, then **return it**. Wait for the value to *change* and let the `check` assert what it changed to — a `pred` that restates the assertion makes the check tautological. Returns the stale value on timeout rather than throwing, so the failure surfaces as the check it belongs to. |
| `waitStable(read)` | the value stopped changing. For state the app writes more than once per action, such as the routing hash. |
| `flushWrites(cdp)` | make the app's rate-limited writes land now. Hides the page and puts it straight back, so the flush a real backgrounded tab gets is the one the test gets — the production `visibilitychange` listener is the hook, and no test-only hook belongs in the app for this. |

## Process plumbing

| Helper | What it does |
|--------|--------------|
| `startDevServer()` | boots `npm run dev` on a random free port |
| `startChrome(userDataDir, {width, height})` | launches headless Chrome on a random port with a clean profile |
| `openPage(chromeBase, url)` | opens a tab and returns a connected `Cdp` client |
| `setFileInput` / `loadFile` | load a file through the app's own `<input type="file">` |
| `activeTab` / `drainProblems` | read the selected view; collect console and page errors |
| `buildCore()` | refresh `@zpcrweb/core`'s `dist/` so a Node-side import isn't testing the page's current source against a months-old build |
| `cfxPassword()` | read the CFX password from the gitignored `secrets.json` |
| `cdp.on(method, fn)` | react to a CDP event as it arrives, for anything that has to *answer* one |
| `stubGithubApi(cdp, {repo, files, token})` | answer `api.github.com` in the page from a made-up repository (see below) |
| `REPO`, `sleep` | repo root; the raw timer, for negative assertions only |

Two things in here are load-bearing and easy to undo by accident:

- **Children are spawned `detached` and killed by process group.** `npm run dev` execs `vite` as a
  grandchild and Chrome forks helpers; killing only the direct child orphans those, and an orphan
  holding the inherited stdio pipe keeps the calling shell waiting forever after the script exits.
- **Chrome gets `--disable-component-update --disable-background-networking`.** Without them the
  auto-updater spawns a child that holds stdout open, and a finished run looks like a hang.

Ports are always random and never 5173 — the user may have a dev server there.

## Chrome flags

Chrome is launched `--headless=new`, always. This account has no interactive desktop session, so a
headful Chrome has no display to open a window on: it hangs rather than showing anything, and
nobody is watching a screen for it. Set `CHROME_PATH` if Chrome isn't at
`/Applications/Google Chrome.app`.

## The stubbed GitHub API

`stubGithubApi` intercepts `https://api.github.com/*` with the CDP `Fetch` domain and answers the
two calls the app makes — a directory listing and a file's raw bytes — out of a repository described
in the test: a map of repository path → local file, with directories derived from those paths.
Passing a `token` makes the repository private, so a request without that bearer token gets the same
bare 404 GitHub answers with (it does not admit a private repo exists).

Stubbed rather than pointed at a real repository, because the alternative is a test that depends on
somebody else's repo still existing, on the network, and on 60 anonymous requests an hour. The bytes
served are real samples, so the app decodes exactly what it would from GitHub. The returned
`{ paths }` records every contents path requested, in order, which is how a check asserts the tree is
listed one directory at a time rather than walked.

Two mechanics worth knowing before changing it. The app's requests carry `Authorization` and
`X-GitHub-Api-Version`, neither CORS-safelisted, so **every request is preflighted** and the `OPTIONS`
has to be answered too. And a fulfilled response still faces the browser's CORS check, so the
`Access-Control-Allow-*` headers are not decoration.

## Gotcha: hover

Rail hover ("peek") needs a real `Input.dispatchMouseEvent`. React derives
`onMouseEnter`/`onMouseLeave` from an over/out pair plus `relatedTarget`, so a synthesized
`mouseover` silently does nothing.
