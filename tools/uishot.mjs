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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import {
  Cdp,
  REPO,
  activeTab,
  cfxPassword,
  drainProblems,
  loadFile,
  openPage,
  sleep,
  startChrome,
  startDevServer,
  waitFor,
} from "./harness.mjs";

const VIEW_LABELS = {
  overview: "Overview",
  curves: "Curves",
  calibration: "Calibration",
  plates: "Plates",
  reference: "Reference",
  raw: "Raw files",
  // Reached by clicking the logo, so it has no tab to go `aria-selected` — matched by the
  // rendered card instead (see the `settle` branch below).
  about: null,
};

function parseArgs(argv) {
  const out = {
    views: ["overview", "curves"],
    file: "samples/20260720_FirstQualification.zpcr",
    out: "tools/.uishot/shot.png",
    width: 1000,
    height: 760,
    maxWidth: 1400,
    url: "/",
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

// Progress goes to stderr so a stalled run shows where it stalled; the final report on
// stdout stays clean enough to read in one glance.
const t_start = Date.now();
const step = (msg) =>
  process.stderr.write(`  [${((Date.now() - t_start) / 1000).toFixed(1)}s] ${msg}\n`);

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
  cdp.close();
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
  const chrome = await startChrome(join(scratch, "profile"), {
    width: opts.width,
    height: opts.height,
  });
  const problems = [];
  const shots = [];

  try {
    // Password goes in the hash, not the query string — fragments are never sent to the
    // server, and the app strips it from the URL as soon as it reads it. See CLAUDE.md.
    const q = new URLSearchParams();
    if (pw) q.set("cfxPassword", pw);
    const pageUrl = `${dev.base}${opts.url}${q.toString() ? `#${q}` : ""}`;
    step(`chrome up; opening ${pageUrl.replace(/cfxPassword=[^&]*/, "cfxPassword=***")}`);

    const cdp = await openPage(chrome.base, pageUrl, {
      domains: ["Page", "Runtime", "Log", "DOM"],
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    step("page loaded");
    if (opts.file) {
      await loadFile(cdp, resolve(REPO, opts.file));
      step(`loaded ${opts.file}`);
    }

    for (const view of opts.views) {
      const label = VIEW_LABELS[view];
      const caption = label ?? "About";
      // Navigate via the URL hash rather than clicking the tab — one assignment, no
      // dependency on tab label text, and it exercises the same routing a shared link uses.
      await cdp.eval(`window.location.hash = ${JSON.stringify(`view=${view}`)}, undefined`);
      let settled = "none";
      try {
        await waitFor(
          async () =>
            label === null
              ? (settled = (await cdp.eval("!!document.querySelector('.about')")) ? view : "none") === view
              : (settled = await activeTab(cdp)) === label,
          {
            timeout: 5000,
            what: `view "${view}" to activate`,
          },
        );
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
      shots.push({ view: caption, data });
      step(`captured ${caption}`);
      problems.push(...drainProblems(cdp));
    }
    problems.push(...drainProblems(cdp));

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
