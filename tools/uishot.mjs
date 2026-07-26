#!/usr/bin/env node
/**
 * uishot — one-call headless screenshot check for the web app.
 *
 * Boots a dev server on a free port, drives a headless Chrome over CDP (no Puppeteer, no
 * dependencies — Node's global `WebSocket` speaks the protocol directly), loads a sample
 * file, walks the requested views, and writes a single contact-sheet PNG plus a short text
 * report of console/page errors.
 *
 * The point is token economy: every click, reload and wait happens *inside* this script, so
 * an agent pays for one command's output and one image rather than a round-trip per step.
 * See CLAUDE.md "UI testing".
 *
 *   node tools/uishot.mjs                            # overview+curves of the default sample
 *   node tools/uishot.mjs --views curves --width 1100
 *   node tools/uishot.mjs --file samples/foo.pcrd --views overview,plates,raw
 *   node tools/uishot.mjs --url /?foo=1 --views overview   # extra query params
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Chrome's auto-updater child holds stdout open and makes runs look like a hang; the
// component-update/background-networking flags below are what keep it from spawning.
const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--disable-background-networking",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
];

const VIEW_LABELS = {
  overview: "Overview",
  curves: "Curves",
  plates: "Plates",
  reference: "Reference",
  raw: "Raw files",
};

function parseArgs(argv) {
  const out = {
    views: ["overview", "curves"],
    file: "samples/20260720.zpcr",
    out: "tools/.uishot/shot.png",
    width: 1000,
    height: 760,
    maxWidth: 1400,
    url: "/",
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, inlineV] = argv[i].split(/=(.*)/s);
    const v = inlineV ?? argv[++i];
    switch (k) {
      case "--views": out.views = v.split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--file": out.file = v; break;
      case "--out": out.out = v; break;
      case "--width": out.width = Number(v); break;
      case "--height": out.height = Number(v); break;
      case "--max-width": out.maxWidth = Number(v); break;
      case "--url": out.url = v; break;
      case "--no-file": out.file = ""; i--; break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  const bad = out.views.filter((v) => !(v in VIEW_LABELS));
  if (bad.length) {
    throw new Error(
      `unknown view(s): ${bad.join(", ")} — valid: ${Object.keys(VIEW_LABELS).join(", ")}`,
    );
  }
  return out;
}

function cfxPassword() {
  const p = join(REPO, "secrets.json");
  if (!existsSync(p)) return "";
  try {
    return JSON.parse(readFileSync(p, "utf8")).cfxPassword ?? "";
  } catch {
    return "";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Progress goes to stderr so a stalled run shows where it stalled; the final report on
// stdout stays clean enough to read in one glance.
const t_start = Date.now();
const step = (msg) =>
  process.stderr.write(`  [${((Date.now() - t_start) / 1000).toFixed(1)}s] ${msg}\n`);

/** Poll `fn` until it returns truthy or `timeout` elapses. */
async function waitFor(fn, { timeout = 20000, interval = 150, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

/** Minimal CDP client over a single page target's WebSocket. */
class Cdp {
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
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: CDP timeout`));
      }, 30000);
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
}

/** Start the vite dev server on a free port; resolve with its base URL. */
async function startDevServer() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(
    "npm",
    ["run", "dev", "-w", "@zpcrweb/web", "--", "--port", String(port), "--strictPort"],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://localhost:${port}`;
  try {
    await waitFor(
      async () => {
        if (proc.exitCode != null) throw new Error(`dev server exited:\n${log}`);
        try {
          const r = await fetch(base, { signal: AbortSignal.timeout(1000) });
          return r.ok;
        } catch {
          return false;
        }
      },
      { timeout: 45000, what: "dev server" },
    );
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  }
  return { base, stop: () => proc.kill("SIGKILL") };
}

/** Launch headless Chrome; resolve with its CDP HTTP base and a stop handle. */
async function startChrome(userDataDir, width, height) {
  // Always start from a clean profile. The app keeps loaded files in IndexedDB, so a reused
  // profile would carry a previous run's sample into this one — an extra file chip in every
  // screenshot, and a different UI depending on what ran before.
  rmSync(userDataDir, { recursive: true, force: true });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(
    CHROME,
    [
      ...CHROME_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (proc.exitCode != null) throw new Error("chrome exited during startup");
      try {
        const r = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
        return r.ok;
      } catch {
        return false;
      }
    },
    { timeout: 30000, what: "chrome devtools port" },
  );
  return { base, stop: () => proc.kill("SIGKILL") };
}

/**
 * Composite the captured views into one labelled contact sheet, scaled so the sheet is at
 * most `maxWidth` across. Done with a canvas in a scratch page so the script stays
 * dependency-free.
 */
async function composite(cdpBase, shots, maxWidth) {
  const res = await fetch(`${cdpBase}/json/new?about:blank`, { method: "PUT" });
  const target = await res.json();
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  const cols = shots.length > 1 ? 2 : 1;
  const value = await cdp.eval(
    `(async () => {
      const shots = ${JSON.stringify(shots)};
      const cols = ${cols};
      const pad = 8, bar = 26;
      const imgs = await Promise.all(shots.map((s) => new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("decode failed: " + s.view));
        i.src = "data:image/png;base64," + s.data;
      })));
      const w = Math.max(...imgs.map((i) => i.width));
      const h = Math.max(...imgs.map((i) => i.height));
      const rows = Math.ceil(imgs.length / cols);
      const sheetW = cols * w + (cols + 1) * pad;
      const sheetH = rows * (h + bar) + (rows + 1) * pad;
      const scale = Math.min(1, ${maxWidth} / sheetW);
      const c = document.createElement("canvas");
      c.width = Math.round(sheetW * scale);
      c.height = Math.round(sheetH * scale);
      const g = c.getContext("2d");
      g.scale(scale, scale);
      g.fillStyle = "#1b1b1f";
      g.fillRect(0, 0, sheetW, sheetH);
      imgs.forEach((img, n) => {
        const cx = n % cols, cy = Math.floor(n / cols);
        const x = pad + cx * (w + pad);
        const y = pad + cy * (h + bar + pad);
        g.fillStyle = "#e8e8ea";
        g.font = "600 15px system-ui, sans-serif";
        g.textBaseline = "middle";
        g.fillText(shots[n].view, x + 2, y + bar / 2);
        g.drawImage(img, x, y + bar);
        g.strokeStyle = "#4a4a52";
        g.lineWidth = 1;
        g.strokeRect(x + 0.5, y + bar + 0.5, img.width - 1, img.height - 1);
      });
      return c.toDataURL("image/png").split(",")[1];
    })()`,
    { awaitPromise: true },
  );
  cdp.ws.close();
  return value;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const scratch = join(REPO, "tools/.uishot");
  mkdirSync(scratch, { recursive: true });
  const outPath = resolve(REPO, opts.out);
  mkdirSync(dirname(outPath), { recursive: true });

  const pw = cfxPassword();
  const notes = [];
  if (opts.file && !existsSync(resolve(REPO, opts.file))) {
    throw new Error(`sample not found: ${opts.file}`);
  }
  if (!pw) notes.push("no secrets.json cfxPassword — encrypted content will stay locked");

  const t0 = Date.now();
  step("starting dev server");
  const dev = await startDevServer();
  step(`dev server ${dev.base}; launching chrome`);
  const chrome = await startChrome(join(scratch, "profile"), opts.width, opts.height);
  const problems = [];
  const shots = [];

  try {
    // Password goes in the hash, not the query string — fragments are never sent to the
    // server, and the app strips it from the URL as soon as it reads it. See CLAUDE.md.
    const q = new URLSearchParams();
    if (pw) q.set("cfxPassword", pw);
    const pageUrl = `${dev.base}${opts.url}${q.toString() ? `#${q}` : ""}`;

    const res = await fetch(`${chrome.base}/json/new?${encodeURIComponent(pageUrl)}`, {
      method: "PUT",
    });
    const target = await res.json();
    step(`chrome up; opening ${pageUrl.replace(/cfxPassword=[^&]*/, 'cfxPassword=***')}`);
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Collect anything that would show up red in a devtools console.
    const note = (kind, text) => {
      if (!text) return;
      // Vite's HMR client chatters on connect; not a page defect.
      if (/\[vite\]/i.test(text)) return;
      problems.push(`${kind}: ${text.slice(0, 300)}`);
    };
    const drain = () => {
      for (const ev of cdp.events.splice(0)) {
        if (ev.method === "Runtime.exceptionThrown") {
          note("uncaught", ev.params.exceptionDetails?.exception?.description ??
            ev.params.exceptionDetails?.text);
        } else if (ev.method === "Runtime.consoleAPICalled" && /error|warning/.test(ev.params.type)) {
          note(ev.params.type, ev.params.args?.map((a) => a.description ?? a.value).join(" "));
        } else if (ev.method === "Log.entryAdded" && /error|warning/.test(ev.params.entry.level)) {
          note(ev.params.entry.level, ev.params.entry.text);
        }
      }
    };

    await waitFor(() => cdp.eval("document.readyState === 'complete'"), { what: "page load" });

    step("page loaded");
    if (opts.file) {
      const nodeId = await (async () => {
        const { root } = await cdp.send("DOM.getDocument");
        const r = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: 'input[type="file"]',
        });
        return r.nodeId;
      })();
      if (!nodeId) throw new Error("no file input found on the page");
      await cdp.send("DOM.setFileInputFiles", {
        nodeId,
        files: [resolve(REPO, opts.file)],
      });
      // The run is parsed/decrypted async; the view tabs only exist once it lands.
      await waitFor(
        () => cdp.eval(`!!document.querySelector('[role="tab"]')`),
        { what: "file to load (view tabs)", timeout: 60000 },
      );
      step(`loaded ${opts.file}`);
    }

    for (const view of opts.views) {
      const label = VIEW_LABELS[view];
      // Navigate via the URL hash rather than clicking the tab — one assignment, no
      // dependency on tab label text, and it exercises the same routing a shared link uses.
      await cdp.eval(
        `window.location.hash = ${JSON.stringify(`view=${view}`)}, undefined`,
      );
      const activeTab = () =>
        cdp.eval(
          `(() => {
            const t = document.querySelector('[role="tab"][aria-selected="true"]');
            return t ? t.textContent.trim() : "none";
          })()`,
        );
      let settled = "none";
      try {
        await waitFor(async () => (settled = await activeTab()) === label, {
          timeout: 5000,
          what: `view "${view}" to activate`,
        });
      } catch {
        problems.push(
          `view "${view}" did not activate (tab shows "${settled}") — not available for this file?`,
        );
        continue;
      }
      // Let charts/tables paint; uPlot draws on rAF.
      await sleep(500);
      await cdp.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", {
        awaitPromise: true,
      });
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      shots.push({ view: label, data });
      step(`captured ${label}`);
      drain();
    }
    drain();

    if (!shots.length) throw new Error("no views captured");
    step("compositing");
    const sheet = await composite(chrome.base, shots, opts.maxWidth);
    writeFileSync(outPath, Buffer.from(sheet, "base64"));
  } finally {
    chrome.stop();
    dev.stop();
  }

  // Compact report — this text is the only thing an agent reads besides the image.
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const px = await imageSize(outPath);
  console.log(`uishot: ${shots.map((s) => s.view).join(" + ")}`);
  console.log(`  file    ${opts.file || "(none)"}`);
  console.log(`  sheet   ${opts.out} ${px.w}x${px.h} (~${Math.round((px.w * px.h) / 750)} image tokens)`);
  console.log(`  took    ${secs}s`);
  for (const n of notes) console.log(`  note    ${n}`);
  if (problems.length) {
    console.log(`  PROBLEMS (${problems.length}):`);
    for (const p of problems.slice(0, 12)) console.log(`    - ${p}`);
  } else {
    console.log("  console clean");
  }
}

/** Read width/height straight out of the PNG IHDR. */
async function imageSize(path) {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

main().catch((e) => {
  console.error(`uishot failed: ${e.message}`);
  process.exit(1);
});
