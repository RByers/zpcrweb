/**
 * Shared browser-automation harness for `uishot.mjs` (screenshots) and `uitest.mjs`
 * (assertions).
 *
 * Speaks the Chrome DevTools Protocol directly over Node's global `WebSocket`, so neither tool
 * needs Puppeteer or any other dependency — just Node and the system Chrome.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Chrome's auto-updater child holds stdout open and makes runs look like a hang long after the
// page is done; the component-update/background-networking flags keep it from spawning.
const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Kill a child *and everything it spawned*.
 *
 * `npm run dev` execs `vite` as a grandchild and Chrome forks helper processes; killing only
 * the direct child orphans those, and an orphan that inherited our stdio pipe keeps the
 * calling shell waiting forever after the script itself has exited. Spawning `detached` makes
 * each child a process-group leader so a negative pid signals the whole group.
 */
function killGroup(proc) {
  if (!proc.pid || proc.exitCode != null) return;
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** A random high port. Never 5173 — the user may have a dev server there. */
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

/**
 * Poll `fn` until it returns truthy or `timeout` elapses.
 *
 * The 50 ms interval is a compromise, not a floor: every wait overshoots by half an interval on
 * average, across ~200 call sites, so the cost of a lazy value is real. Below ~40 ms the CDP
 * round-trips start competing with the rendering they are waiting on.
 */
export async function waitFor(fn, { timeout = 20000, interval = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

/**
 * Every soft timeout that has fired this run — see {@link noteSoftTimeout}.
 *
 * `waitValue` and `waitStable` deliberately do not throw, so a caller can go on to assert what it
 * actually saw. That is right for the failure message and wrong for the exit code: a wait for
 * something that never happens is a broken test whether or not the `check` after it notices. Two
 * such waits sat in this suite for months costing 8 s and 10 s a run, both behind checks that
 * passed — one waiting for a well count to change when nothing would change it, one waiting for
 * two file chips when the line above had just proved there were three.
 *
 * So the value still comes back, and the timeout is still recorded. `uitest` turns each one into a
 * failed check at the end of the run.
 */
const softTimeouts = [];

/** Record a wait that gave up, and say so on the spot. */
export function noteSoftTimeout(what, value, ms) {
  softTimeouts.push({ what, value });
  console.log(
    `    ⏱ gave up after ${(ms / 1000).toFixed(1)}s waiting for ${what} ` +
      `— continuing with ${JSON.stringify(value)}`,
  );
}

/** The soft timeouts recorded so far, for the runner to fail on. */
export const softTimeoutsSeen = () => softTimeouts;

/**
 * Poll `read()` until its value satisfies `pred`, then return it — the replacement for a fixed
 * `sleep` in front of a `check`.
 *
 * Two things distinguish it from {@link waitFor}, and both matter for keeping the checks honest:
 *
 * - **It returns the value rather than a boolean**, so the caller goes on asserting what it
 *   actually saw. The idiom is to wait for the state to *change* and then assert *what it
 *   changed to* — `pred` is "different from before", the `check` is "and it is now this". A
 *   `pred` that restates the assertion would make the check tautological; one that waits for
 *   change does not.
 * - **It returns on timeout instead of throwing**, handing back the stale value. A regression
 *   then fails as the check it belongs to, naming the value it got, rather than as a bare
 *   timeout thrown from inside the harness.
 *
 * The timeout is recorded either way ({@link softTimeouts}), so it cannot pass unnoticed. `what`
 * is what that record says; give it one. There is deliberately no opt-out: a wait that is allowed
 * to expire quietly is how both of the timeouts above survived, and "this might legitimately not
 * arrive" is a negative assertion, which is a `sleep` with a comment rather than a wait.
 */
export async function waitValue(
  read,
  pred,
  { timeout = 8000, interval = 50, what = "a value to change" } = {},
) {
  const deadline = Date.now() + timeout;
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (pred(value)) return value;
    if (Date.now() > deadline) {
      noteSoftTimeout(what, value, Date.now() - started);
      return value;
    }
    await sleep(interval);
  }
}

/**
 * Park the page on `about:blank` and wait until it is really there.
 *
 * The step before a deliberately *cold* start: navigating straight from one fragment of the app's
 * URL to another is a same-document navigation, so the app would keep its state and only the hash
 * listener would fire. Going via `about:blank` forces a real document load.
 *
 * The wait is for `location.href`, not a fixed delay — during the navigation `Runtime.evaluate`
 * can land in either document or fail outright while the context is swapped, so a failed read is
 * treated as "not there yet" rather than an error.
 */
export async function navigateBlank(cdp) {
  await cdp.send("Page.navigate", { url: "about:blank" });
  await waitFor(
    async () => (await cdp.eval("location.href").catch(() => null)) === "about:blank",
    { what: "the page to go blank" },
  );
}

/**
 * Make the app flush its pending write-behind, by hiding the page.
 *
 * Three of the app's writes are rate-limited rather than immediate — a `.zpcr`'s analysis
 * settings, a `.prcl.txt`'s protocol text, and the write-back to a file on disk (`writeThrottle.ts`,
 * `analysisPersist.ts`). A test that wants the edit *on storage* rather than merely on screen
 * therefore has to wait out an interval it does not control, up to 60 s for the analysis one.
 *
 * It doesn't have to. `WriteThrottle.attach` already flushes everything pending on
 * `visibilitychange` → hidden, because a backgrounded tab may never come back — so the shortcut
 * the tests need is the production path, driven from outside. No test-only hook exists in the app
 * and none should: this exercises the same listener a real backgrounded tab does.
 *
 * Chrome no longer implements `Emulation.setPageVisibilityState`, and `Page.setWebLifecycleState`
 * freezes the page without reliably thawing it (it stayed `hidden`, which throttles every timer
 * afterwards). So the visibility is overridden for exactly as long as the event takes to
 * dispatch, and put straight back — `document.visibilityState` reads `visible` again on return.
 *
 * The flush is started, not awaited: the listener is `void this.flushAll()`, so there is no
 * completion signal to hook. Callers still need to wait for the write to land — but for
 * something short and bounded, rather than for a rate limit.
 */
export async function flushWrites(cdp) {
  await cdp.eval(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
    return document.visibilityState;
  })()`);
}

/**
 * Poll `read()` until it returns the same value `quiet` ms running, and return it.
 *
 * For state the app writes more than once per user action. `waitValue(…, changed)` returns on the
 * *first* write, which is right for reading a rendered value but wrong when the next step depends
 * on the app having finished — notably the routing hash, where acting on the first write can put
 * `history.back()` on an entry that is about to be superseded.
 *
 * Timing out here means the value never stopped moving, which is a real finding rather than a slow
 * machine — so it is recorded like {@link waitValue}'s.
 */
export async function waitStable(
  read,
  { quiet = 250, timeout = 5000, interval = 50, what = "a value to settle" } = {},
) {
  const deadline = Date.now() + timeout;
  const started = Date.now();
  let last = await read();
  let since = Date.now();
  for (;;) {
    await sleep(interval);
    const now = await read();
    if (JSON.stringify(now) !== JSON.stringify(last)) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quiet) {
      return last;
    }
    if (Date.now() > deadline) {
      noteSoftTimeout(what, last, Date.now() - started);
      return last;
    }
  }
}

/** The local CFX decryption password, or "" when `secrets.json` is absent. */
export function cfxPassword() {
  const p = join(REPO, "secrets.json");
  if (!existsSync(p)) return "";
  try {
    return JSON.parse(readFileSync(p, "utf8")).cfxPassword ?? "";
  } catch {
    return "";
  }
}

/** Minimal CDP client bound to a single target's WebSocket. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        // Clear the watchdog, or its 30s timer keeps the event loop alive long after the
        // work is done and the process appears to hang before exiting.
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        this.events.push(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP websocket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: CDP timeout`));
      }, 30000);
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression, { awaitPromise = false } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `page eval threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    }
    return r.result.value;
  }

  close() {
    if (this.targetId) {
      fetch(`${this.chromeBase}/json/close/${this.targetId}`).catch(() => {});
    }
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Rebuild `@zpcrweb/core`'s `dist/`, and fail loudly if it doesn't work.
 *
 * The app under test doesn't need this — `vite.config.ts` aliases `@zpcrweb/core` to its
 * TypeScript *source*, so the browser always runs current code. But a test script that builds a
 * fixture by importing the library from Node gets `dist/` instead, which nothing else in the repo
 * keeps current and which `.gitignore` excludes. That splits one run across two versions of core:
 * the page on today's source, the fixture on whatever was last built. It fails as
 * `<symbol> is not a function` — a stale build, reported as if the export had been deleted.
 *
 * Importing the source here instead would close the gap at its root, but Node's type stripping
 * can't resolve the `.js` specifiers core's source uses to import itself. So: build first, every
 * run. `tsup` is about a second against the ~100s the suite already takes.
 */
export async function buildCore() {
  const proc = spawn("npm", ["run", "build", "-w", "@zpcrweb/core"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const code = await new Promise((r) => proc.on("exit", r));
  if (code !== 0) throw new Error(`building @zpcrweb/core failed (exit ${code}):\n${log}`);
}

/** Start the Vite dev server on a random free port; resolve with its base URL and a stop handle. */
export async function startDevServer() {
  const port = randomPort();
  const proc = spawn(
    "npm",
    ["run", "dev", "-w", "@zpcrweb/web", "--", "--port", String(port), "--strictPort"],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  // Vite binds ::1, so `localhost` resolves where a literal 127.0.0.1 would not.
  const base = `http://localhost:${port}`;
  try {
    await waitFor(
      async () => {
        if (proc.exitCode != null) throw new Error(`dev server exited:\n${log}`);
        try {
          return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {
          return false;
        }
      },
      { timeout: 45000, what: "dev server" },
    );
  } catch (e) {
    killGroup(proc);
    throw e;
  }
  return { base, stop: () => killGroup(proc) };
}

/**
 * Launch headless Chrome on a random debugging port; resolve with its CDP HTTP base and a stop
 * handle. The profile directory is wiped first: the app keeps loaded files in IndexedDB, so a
 * reused profile would carry a previous run's sample into this one.
 */
export async function startChrome(userDataDir, { width = 1000, height = 760 } = {}) {
  rmSync(userDataDir, { recursive: true, force: true });
  const port = randomPort();
  const proc = spawn(
    CHROME,
    [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (proc.exitCode != null) throw new Error("chrome exited during startup");
      try {
        return (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    { timeout: 30000, what: "chrome devtools port" },
  ).catch((e) => {
    killGroup(proc);
    throw e;
  });
  return { base, stop: () => killGroup(proc) };
}

/** Open `url` in a new tab and return a connected {@link Cdp} with the usual domains enabled. */
export async function openPage(chromeBase, url, { domains = ["Page", "Runtime", "DOM"] } = {}) {
  const res = await fetch(`${chromeBase}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = await res.json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  cdp.targetId = target.id;
  cdp.chromeBase = chromeBase;
  for (const d of domains) await cdp.send(`${d}.enable`);
  await waitFor(() => cdp.eval("document.readyState === 'complete'"), { what: "page load" });
  return cdp;
}

/**
 * Load a local file through the app's own `<input type="file">`.
 *
 * This is deliberately the real user path — the same `addFiles` → validate → IndexedDB flow a
 * drag-and-drop triggers — rather than seeding IndexedDB directly, which would skip validation
 * and so could "pass" on a file the app cannot actually open.
 */
/**
 * Put `absPath` on the `<input type=file>` matching `selector` — the real user gesture, as far as
 * the page can tell. Shared by {@link loadFile} and any other input the app exposes (the Instrument
 * view's `.prcl.txt` picker), so there is one place that knows the CDP dance.
 */
export async function setFileInput(cdp, selector, absPath, { timeout = 60000 } = {}) {
  // The input only exists once the app has rendered — during the boot splash (and briefly
  // after a reload, e.g. `uitest`'s `emptyReload`) there is nothing to set files on. Wait for
  // it rather than racing the first paint, and only then take a document snapshot, so the
  // nodeIds below refer to the DOM that actually has the input in it.
  await waitFor(() => cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`), {
    timeout,
    what: `the ${selector} file input`,
  });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no file input found for ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [absPath] });
}

export async function loadFile(cdp, absPath, { timeout = 60000 } = {}) {
  await setFileInput(cdp, 'input[type="file"]', absPath, { timeout });
  // The run is parsed/decrypted async; the view tabs only exist once it lands.
  await waitFor(() => cdp.eval(`!!document.querySelector('[role="tab"]')`), {
    timeout,
    what: "file to load (view tabs)",
  });
}

/** Text of the currently selected view tab, or "none". */
export function activeTab(cdp) {
  return cdp.eval(
    `(() => {
      const t = document.querySelector('[role="tab"][aria-selected="true"]');
      return t ? t.textContent.trim() : "none";
    })()`,
  );
}

/** Collect console errors/warnings and uncaught exceptions seen so far. */
export function drainProblems(cdp) {
  const out = [];
  const note = (kind, text) => {
    if (!text) return;
    if (/\[vite\]/i.test(text)) return; // HMR client chatter, not a page defect
    out.push(`${kind}: ${String(text).slice(0, 300)}`);
  };
  for (const ev of cdp.events.splice(0)) {
    if (ev.method === "Runtime.exceptionThrown") {
      note(
        "uncaught",
        ev.params.exceptionDetails?.exception?.description ?? ev.params.exceptionDetails?.text,
      );
    } else if (ev.method === "Runtime.consoleAPICalled" && /error|warning/.test(ev.params.type)) {
      note(ev.params.type, ev.params.args?.map((a) => a.description ?? a.value).join(" "));
    } else if (ev.method === "Log.entryAdded" && /error|warning/.test(ev.params.entry.level)) {
      note(ev.params.entry.level, ev.params.entry.text);
    }
  }
  return out;
}
