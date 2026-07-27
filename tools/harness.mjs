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

/** Poll `fn` until it returns truthy or `timeout` elapses. */
export async function waitFor(fn, { timeout = 20000, interval = 150, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
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
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
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
export async function loadFile(cdp, absPath, { timeout = 60000 } = {}) {
  // The input only exists once the app has rendered — during the boot splash (and briefly
  // after a reload, e.g. `uitest`'s `emptyReload`) there is nothing to set files on. Wait for
  // it rather than racing the first paint, and only then take a document snapshot, so the
  // nodeIds below refer to the DOM that actually has the input in it.
  await waitFor(() => cdp.eval(`!!document.querySelector('input[type="file"]')`), {
    timeout,
    what: "the app's file input",
  });
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeId) throw new Error("no file input found on the page");
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [absPath] });
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
