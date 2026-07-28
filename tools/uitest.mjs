#!/usr/bin/env node
/**
 * uitest — browser assertions for the two URL contracts that nothing else can catch.
 *
 * Hash routing and the password handling are invisible to the core Vitest suite (no DOM) and
 * to `uishot.mjs` (a screenshot can't show that back/forward works, or that a secret leaked
 * into the address bar). Everything here is a real regression risk that fails silently.
 *
 *   npm run test:ui
 *   node tools/uitest.mjs
 *
 * Deliberately *not* part of `npm test`: it needs Chrome and takes ~20s, while the core suite
 * is dependency-free and runs in ~3s. Exits non-zero on any failure.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  REPO,
  activeTab,
  cfxPassword,
  loadFile,
  openPage,
  sleep,
  startChrome,
  startDevServer,
  waitFor,
} from "./harness.mjs";

const ZPCR = join(REPO, "samples/20260720_FirstQualification.zpcr");
const PCRD = join(REPO, "samples/20260720_Luna_noRT.pcrd");
const PLTD = join(REPO, "samples/QuickPlate_96 wells_All Channels.pltd");
const EXAMPLE = "20260726_S183-S185_RVP.zpcr";
/** Written by {@link makeDupe}: the example under its own name but a different size. */
const DUPE = join(REPO, "tools/.uishot/dupe", EXAMPLE);

/**
 * A same-name, *different-size* copy of the example — the only way to exercise the replace rule,
 * since `fileId()` hashes name+size and a byte-identical reload is simply the same id. Four
 * trailing zero bytes: a ZIP reader finds the end-of-central-directory by scanning backwards, so
 * the archive still parses.
 */
function makeDupe() {
  mkdirSync(dirname(DUPE), { recursive: true });
  writeFileSync(DUPE, Buffer.concat([readFileSync(join(REPO, "samples", EXAMPLE)), Buffer.alloc(4)]));
}

/** Reload `url` with an empty IndexedDB, via `about:blank` so the app really re-boots (a
 * same-document hash change would not). */
async function emptyReload(cdp, url) {
  await cdp.eval(
    `new Promise(r => { const q = indexedDB.deleteDatabase("zpcrweb");
       q.onsuccess = q.onerror = q.onblocked = () => r(true); })`,
  );
  await cdp.send("Page.navigate", { url: "about:blank" });
  await sleep(200);
  await cdp.send("Page.navigate", { url });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  → ${detail}` : ""}`);
}

/** Wait for the active tab to read `label`, returning whatever it actually settled on. */
async function tabBecomes(cdp, label, timeout = 8000) {
  let seen = "none";
  try {
    await waitFor(async () => (seen = await activeTab(cdp)) === label, { timeout, what: label });
  } catch {
    /* fall through with whatever we last saw */
  }
  return seen;
}

/**
 * The Calibration view's default selection. A run ships a `.Dcal` for every dye Bio-Rad sells on
 * both tube types (28 files in the samples here), and the view is only useful because it starts
 * with the handful the analysis actually reads — this plate's fluorophores on this plate's tube
 * type. That seeding runs once per run against IndexedDB-backed state, so it silently degrades
 * into "all 28" or "none" in ways no unit test sees.
 */
async function calibrationChecks(chrome, origin) {
  console.log("\ncalibration view");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  await cdp.eval(`window.location.hash = "view=calibration", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".calgroup")`), { what: "calibration rail" });
  await sleep(400);

  /** Every calibration chip, with the plate-type group it sits in. */
  const chips = () =>
    cdp.eval(`[...document.querySelectorAll(".calgroup")].flatMap((g) => {
      const group = g.querySelector(".calgroup__title").textContent.replace("plate", "").trim();
      return [...g.querySelectorAll(".chanchip")].map((b) => ({
        group,
        dye: b.querySelector(".chanchip__ch").textContent,
        on: b.getAttribute("aria-pressed") === "true",
      }));
    })`);

  const initial = await chips();
  const on = initial.filter((c) => c.on);
  check(
    "every calibration in the archive gets a chip, grouped by tube type",
    initial.length === 28 && new Set(initial.map((c) => c.group)).size === 2,
    `${initial.length} chips, groups ${[...new Set(initial.map((c) => c.group))].join("/")}`,
  );
  check(
    "only the calibrations this run's analysis uses are on by default",
    on.length === 3 &&
      on.every((c) => c.group === "BR Clear") &&
      ["Cy5", "FAM", "Tex 615"].every((d) => on.some((c) => c.dye === d)),
    on.map((c) => `${c.dye} (${c.group})`).join(", ") || "none on",
  );

  // The rest are one click away — the whole point of the view over the raw per-file table.
  await cdp.eval(`(() => { const g = [...document.querySelectorAll(".calgroup")]
      .find((x) => x.querySelector(".calgroup__title").textContent.includes("BR White"));
      [...g.querySelectorAll(".chanchip")].find((b) =>
        b.querySelector(".chanchip__ch").textContent === "FAM").click(); })()`);
  await sleep(300);
  const afterOn = (await chips()).filter((c) => c.on);
  check(
    "clicking an unused calibration's chip adds it",
    afterOn.length === 4 && afterOn.some((c) => c.dye === "FAM" && c.group === "BR White"),
    afterOn.map((c) => `${c.dye} (${c.group})`).join(", "),
  );

  // Absolute mode splits each response curve back into the two raw reads it's the difference of
  // (dye plate + empty plate), so the plotted line count has to double for the same selection.
  // The count is derived state three layers down (settings → series → uPlot), and the empty-plate
  // half exists nowhere else in the app — a broken switch would just look like a busier chart.
  const curveCount = () =>
    cdp.eval(`+(document.querySelector(".rail__stat").textContent.match(/· (\\d+) curves/) || [])[1]`);
  const clickToggle = (text) =>
    cdp.eval(`(() => { const t = [...document.querySelectorAll(".toggle")]
        .find((x) => x.querySelector(".toggle__label").textContent === "Values");
      [...t.querySelectorAll(".segmented__item")]
        .find((b) => b.textContent === ${JSON.stringify(text)}).click(); })()`);

  const relativeCurves = await curveCount();
  await clickToggle("Absolute");
  await sleep(300);
  const absoluteCurves = await curveCount();
  await clickToggle("Relative");
  await sleep(300);
  const backToRelative = await curveCount();
  check(
    "absolute mode plots both raw reads, relative mode just their difference",
    relativeCurves > 0 &&
      absoluteCurves === relativeCurves * 2 &&
      backToRelative === relativeCurves,
    `${relativeCurves} → ${absoluteCurves} → ${backToRelative} curves`,
  );

  cdp.close();
}

async function routingChecks(chrome, origin, pw) {
  console.log("\nhash routing");
  const cdp = await openPage(chrome.base, `${origin}#cfxPassword=${encodeURIComponent(pw)}`);
  await loadFile(cdp, ZPCR);
  await sleep(600);

  const h1 = await cdp.eval("window.location.hash");
  check("hash carries file+view once a file is active", /file=/.test(h1) && /view=/.test(h1), h1);
  check(
    "file param round-trips the real name",
    new URLSearchParams(h1.replace(/^#/, "")).get("file") === "20260720_FirstQualification.zpcr",
  );

  // Clicking a tab must write the hash — this is what makes any view linkable.
  await cdp.eval(
    `(() => { const b = [...document.querySelectorAll('[role="tab"]')]
        .find(x => x.textContent.trim() === "Plates"); b && b.click(); })()`,
  );
  await sleep(400);
  check("clicking a tab writes view= to the hash", /view=plates/.test(await cdp.eval("window.location.hash")));

  // pushState (not replaceState) on user-driven changes is what makes these two work.
  await cdp.eval("window.history.back()");
  const back = await tabBecomes(cdp, "Curves");
  check("back() restores the previous view", back === "Curves", `tab "${back}"`);
  await cdp.eval("window.history.forward()");
  const fwd = await tabBecomes(cdp, "Plates");
  check("forward() re-applies the view", fwd === "Plates", `tab "${fwd}"`);

  // A cold load must honor the hash without flashing the default view first.
  await cdp.send("Page.navigate", { url: `${origin}#file=20260720_FirstQualification.zpcr&view=reference` });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  const cold = await tabBecomes(cdp, "Reference");
  check("cold deep link opens the named view", cold === "Reference", `tab "${cold}"`);

  // Files live in IndexedDB and can't be fetched from a link, so an unknown name must degrade.
  await cdp.send("Page.navigate", { url: `${origin}#file=nope.zpcr&view=plates` });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  const unknown = await tabBecomes(cdp, "Plates");
  check("unknown file falls back but keeps the view", unknown === "Plates", `tab "${unknown}"`);

  await cdp.send("Page.navigate", { url: `${origin}#view=notaview` });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  await sleep(800);
  const junk = await activeTab(cdp);
  check("invalid view value falls back to a real tab", junk !== "none", `tab "${junk}"`);

  cdp.close();
}

/**
 * `#load=<url>` and the welcome screen's example link — the one hash key that reaches the
 * network, plus the "same name replaces" rule. All three are invisible to Vitest (no DOM, no
 * fetch) and to a screenshot (which can't show that a second copy *didn't* appear).
 */
async function loadChecks(chrome, origin) {
  console.log("\nload from URL");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);

  // 1. The welcome screen offers the example as a real link (so "Copy link address" works),
  //    and clicking it loads it.
  const clicked = await cdp.eval(
    `(() => { const a = [...document.querySelectorAll("a")]
        .find(x => /load an example/i.test(x.textContent || ""));
      if (!a) return "missing";
      const href = a.getAttribute("href") || "";
      a.click();
      return /^#load=/.test(href) ? "ok" : "bad href: " + href; })()`,
  );
  check(
    "welcome screen offers an example file as a #load= link",
    clicked === "ok",
    clicked === "ok" ? "" : clicked,
  );
  await waitFor(() => cdp.eval(`/file=/.test(window.location.hash)`), { what: "example loaded" });
  const exampleHash = await cdp.eval("window.location.hash");
  check(
    "example link loads the served sample",
    /file=20260726_S183-S185_RVP\.zpcr/.test(exampleHash),
    exampleHash,
  );
  check("the load= instruction is consumed, not left in the hash", !/load=/.test(exampleHash));

  // 2. Same name, different bytes (a 4-byte-longer copy — ids hash name+size, so this is a new
  //    id) must replace the chip rather than add an indistinguishable second one.
  await loadFile(cdp, DUPE);
  await sleep(800);
  const chips = await cdp.eval(`document.querySelectorAll(".filechip").length`);
  check("re-loading a name replaces the file instead of duplicating it", chips === 1, `${chips} chips`);

  // 3. A cold deep link does the fetch on its own, with nothing in IndexedDB to fall back on.
  await emptyReload(cdp, `${origin}#load=examples/20260726_S183-S185_RVP.zpcr&view=plates`);
  await waitFor(() => cdp.eval(`document.querySelectorAll(".filechip").length === 1`), {
    what: "deep-linked file",
  });
  const cold = await tabBecomes(cdp, "Plates");
  check("cold #load= link fetches the file and honors view=", cold === "Plates", `tab "${cold}"`);

  // 4. A bad URL surfaces an error rather than hanging on the welcome screen.
  await emptyReload(cdp, `${origin}#load=examples/nope.zpcr`);
  await sleep(1200);
  const errored = await cdp.eval(`!!document.querySelector(".app__error")`);
  const stillWelcome = await cdp.eval(`!!document.querySelector(".app--empty")`);
  check("a #load= that 404s reports an error and keeps the welcome screen", errored && stillWelcome);

  cdp.close();
}

/**
 * The chart's right axis holds temperatures *or* LED currents, never both (see
 * `apps/web/src/lib/rightAxis.ts`). Enforced in the store, so no control can break it — but only
 * a browser can show that enabling one really does clear the other, and that each chip previews
 * its own field's value in its own unit.
 */
async function rightAxisChecks(chrome, origin) {
  console.log("\nright axis (temperatures vs LED currents)");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });

  // Both sections exist for a run whose platereads carry both kinds of field.
  const section = (title) => `[...document.querySelectorAll("details.rail__details")]
      .find((d) => (d.querySelector(".rail__title")?.textContent || "").includes(${JSON.stringify(title)}))`;
  const clickAll = (title) =>
    cdp.eval(`(() => { const s = ${section(title)}; if (!s) return "missing";
        s.open = true; s.querySelector(".rail__link").click(); return "ok"; })()`);
  const chips = (title) =>
    cdp.eval(`(() => { const s = ${section(title)}; if (!s) return null;
        return [...s.querySelectorAll(".chanchip")].map((b) => ({
          label: b.querySelector(".chanchip__ch").textContent,
          value: b.querySelector(".chanchip__dye").textContent,
          on: b.getAttribute("aria-pressed") === "true",
        })); })()`);

  check("LED currents get their own rail section", (await clickAll("LED current")) === "ok");
  await sleep(300);
  const leds = (await chips("LED current")) ?? [];
  check(
    "every channel's LED drive current is plotted, previewed in DAC counts",
    leds.length === 6 && leds.every((c) => c.on) && /^\d+ DAC$/.test(leds[0].value),
    leds.map((c) => `${c.label} ${c.value}`).join(", "),
  );

  // Enabling temperatures must take the axis over, not share it.
  check("temperatures get their own rail section", (await clickAll("Temperature")) === "ok");
  await sleep(300);
  const temps = (await chips("Temperature")) ?? [];
  const ledsAfter = (await chips("LED current")) ?? [];
  check(
    "enabling temperatures clears the LED currents — one right axis, one unit",
    temps.some((c) => c.on) && ledsAfter.every((c) => !c.on),
    `${temps.filter((c) => c.on).length} temps on, ${ledsAfter.filter((c) => c.on).length} LEDs on`,
  );

  // And back the other way, so neither direction is the special case.
  await clickAll("LED current");
  await sleep(300);
  const tempsAfter = (await chips("Temperature")) ?? [];
  const ledsBack = (await chips("LED current")) ?? [];
  check(
    "enabling LED currents clears the temperatures",
    ledsBack.every((c) => c.on) && tempsAfter.every((c) => !c.on),
    `${tempsAfter.filter((c) => c.on).length} temps on, ${ledsBack.filter((c) => c.on).length} LEDs on`,
  );

  cdp.close();
}

async function passwordChecks(chrome, origin, pw) {
  console.log("\npassword handling");

  // Hash form: consumed, then stripped so a copied URL can't leak the secret.
  const a = await openPage(chrome.base, `${origin}#cfxPassword=${encodeURIComponent(pw)}`);
  await sleep(500);
  const urlA = await a.eval("window.location.href");
  check("hash password stripped from the URL", !/cfxPassword/i.test(urlA), urlA.replace(origin, "/"));
  check(
    "password persisted to localStorage",
    (await a.eval(`localStorage.getItem("zpcr:pltdPassword")`)) === pw,
  );

  // The real proof it survived the move: an encrypted .pcrd decodes with no prompt.
  await loadFile(a, PCRD).catch(() => {});
  const tabs = await a.eval(`document.querySelectorAll('[role="tab"]').length`);
  const prompted = await a.eval(`!!document.body.textContent.match(/password/i)`);
  check("encrypted .pcrd decrypts with no prompt", tabs > 0 && !prompted, `tabs=${tabs}`);
  a.close();

  // Legacy query form still works, is stripped too, and doesn't eat unrelated params.
  const b = await openPage(chrome.base, `${origin}?cfxPassword=${encodeURIComponent(pw)}&keep=1`);
  await sleep(500);
  const urlB = await b.eval("window.location.href");
  check(
    "legacy ?cfxPassword still accepted",
    (await b.eval(`localStorage.getItem("zpcr:pltdPassword")`)) === pw,
  );
  check("legacy query password stripped", !/cfxPassword/i.test(urlB), urlB.replace(origin, "/"));
  check("unrelated query params preserved", /keep=1/.test(urlB));

  // And it must never reappear in the routing hash written after hydration.
  await loadFile(b, ZPCR);
  await sleep(800);
  const hashB = await b.eval("window.location.hash");
  check("routing hash carries no password", /file=/.test(hashB) && !/cfxPassword/i.test(hashB), hashB);
  b.close();
}

/**
 * Every XML the app shows goes through the one collapsible `<XmlTree>` widget — never the flat
 * `<pre class="raw__dump">` used for hex and plain text. The distinction is invisible to the
 * core suite (no DOM) and easy to regress silently, since a flat dump of XML still "works":
 * it's readable, just unformatted. So assert the widget by its markup (`.decoded__xml`, plus
 * the `<details>` elements that make subtrees collapsible), and assert the converse too —
 * non-XML text must *not* be dressed up as a tree.
 */
async function xmlViewChecks(chrome, origin, pw) {
  console.log("\nXML rendering");

  /** What the raw viewer is currently rendering: the tree, the flat dump, or neither (yet). */
  const shape = (page) =>
    page
      .eval(
        `JSON.stringify({
           tree: !!document.querySelector('.decoded__xml'),
           dump: !!document.querySelector('.raw__dump'),
           collapsed: document.querySelectorAll('.decoded__xml details:not([open])').length,
           roots: document.querySelectorAll('.decoded__xml > details').length,
           rootsOpen: document.querySelectorAll('.decoded__xml > details[open]').length,
         })`,
      )
      .then(JSON.parse);

  /** Wait until *something* has rendered, so the assertion never races an empty viewer — the
   * failure mode this is guarding against ("XML rendered flat") is itself a `.raw__dump`, so
   * settling on "either one is present" is what makes the check meaningful rather than timing. */
  const rendered = async (page, what) => {
    let seen = {};
    await waitFor(async () => ((seen = await shape(page)), seen.tree || seen.dump), {
      what: `${what} to render`,
    });
    return seen;
  };

  // Both pages below start from an empty IndexedDB (see the note at the standalone `.pltd`):
  // whichever file hydration restores would otherwise decide what the raw viewer is showing.
  const url = `${origin}#cfxPassword=${encodeURIComponent(pw)}`;
  const cdp = await openPage(chrome.base, url);
  await emptyReload(cdp, url);

  /** Select a raw-file entry, switch to its text/XML mode, and describe what rendered. */
  const show = async (entry) => {
    await waitFor(
      () =>
        cdp.eval(
          `!!([...document.querySelectorAll('.raw__item')]
             .find(b => b.textContent.trim() === ${JSON.stringify(entry)}))`,
        ),
      { what: `${entry} in the file list` },
    );
    await cdp.eval(
      `[...document.querySelectorAll('.raw__item')]
         .find(b => b.textContent.trim() === ${JSON.stringify(entry)}).click()`,
    );
    await waitFor(
      () =>
        cdp.eval(
          `(() => { const b = [...document.querySelectorAll('.segmented__item')]
              .find(x => /^(Text|XML)$/.test(x.textContent.trim()));
            if (!b || b.disabled) return false;
            if (!b.classList.contains("is-active")) b.click();
            return b.classList.contains("is-active"); })()`,
        ),
      { what: `${entry} text mode` },
    );
    return rendered(cdp, entry);
  };

  // A .zpcr's own XML entries — previously a flat dump, since only .pltd/.prcl were routed to
  // the widget.
  await loadFile(cdp, ZPCR);
  await cdp.eval(`window.location.hash = "view=raw", undefined`);

  const runInfo = await show("RunInfo.xml");
  check("RunInfo.xml renders as the XML tree", runInfo.tree && !runInfo.dump, JSON.stringify(runInfo));
  // `<RunInfo>` has 66 children — far past the collapse threshold — so this is only true because
  // a document's own root is exempt from it. Landing on one collapsed line shows nothing.
  check(
    "a document's single root starts open however wide",
    runInfo.roots === 1 && runInfo.rootsOpen === 1,
    JSON.stringify(runInfo),
  );

  const runLog = await show("runlog.xml");
  check("runlog.xml renders as the XML tree", runLog.tree && !runLog.dump, JSON.stringify(runLog));
  // The exemption is for *a* root: this fragment's 92 sibling records aren't one, and opening
  // them all would defeat the collapsing entirely.
  check(
    "a multi-root fragment still collapses by child count",
    runLog.roots > 1 && runLog.collapsed > 0,
    JSON.stringify(runLog),
  );

  // The converse: plain text must stay a plain dump, so the sniffing isn't just "always tree".
  const txt = await show("ProtocolRunDefinition.txt");
  check("non-XML text stays a plain dump", txt.dump && !txt.tree, JSON.stringify(txt));
  cdp.close();

  // A standalone .pltd opened on its own: its decrypted payload is XML with no .xml in sight,
  // which is why the sniffing is by content rather than by file name.
  // Start from an empty IndexedDB: this profile already holds the runs loaded above, and a
  // hydrated run winning the race would leave a *different* file active — whose raw view is
  // neither tree nor dump (it opens on a Decoded table), so the check would time out rather
  // than fail honestly.
  const solo = await openPage(chrome.base, url);
  await emptyReload(solo, url);
  await loadFile(solo, PLTD);
  await solo.eval(`window.location.hash = "view=raw", undefined`);
  await tabBecomes(solo, "Raw files");
  // Anchor on the viewer actually showing this file before reading its shape.
  await waitFor(
    () =>
      solo.eval(
        `document.querySelector('.raw__fname')?.textContent.trim() === ${JSON.stringify(
          PLTD.split("/").pop(),
        )}`,
      ),
    { what: "the standalone .pltd in the raw viewer" },
  );
  const soloShape = await rendered(solo, "the standalone .pltd");
  check(
    "a standalone .pltd's XML tab renders as the XML tree",
    soloShape.tree && !soloShape.dump,
    JSON.stringify(soloShape),
  );
  solo.close();
}

async function main() {
  const pw = cfxPassword();
  if (!pw) {
    console.error(
      "uitest: no cfxPassword in secrets.json — the password checks need it (see CLAUDE.md).",
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const dev = await startDevServer();
  const chrome = await startChrome(join(REPO, "tools/.uishot/testprofile"));
  try {
    const origin = `${dev.base}/`;
    // First, while IndexedDB is still empty and the welcome screen is showing.
    makeDupe();
    await loadChecks(chrome, origin);
    await routingChecks(chrome, origin, pw);
    await rightAxisChecks(chrome, origin);
    await calibrationChecks(chrome, origin);
    await passwordChecks(chrome, origin, pw);
    await xmlViewChecks(chrome, origin, pw);
  } finally {
    chrome.stop();
    dev.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (failed.length) {
    console.log("failed:");
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`uitest failed: ${e.message}`);
  process.exit(1);
});
