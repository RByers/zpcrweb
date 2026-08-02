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
  setFileInput,
  sleep,
  startChrome,
  startDevServer,
  waitFor,
} from "./harness.mjs";

const ZPCR = join(REPO, "samples/20260720_FirstQualification.zpcr");
const PCRD = join(REPO, "samples/20260720_Luna_noRT.pcrd");
/** Three cycles and three plate reads — short enough that every read keeps its own number. */
const GRADIENT_ZPCR = join(REPO, "samples/20260725_GRADIENTTEST.zpcr");
const PLTD = join(REPO, "samples/QuickPlate_96 wells_All Channels.pltd");
/** The Biomeme run export — the one input format that isn't Bio-Rad's, and the one that names
 * its own run rather than encoding the name in a filename. */
const BIOMEME = join(REPO, "samples/biomeme-2024-01-17.json");
/** The run whose `.pcrd` persists a hand-set FAM threshold — see {@link persistedThresholdChecks}. */
const RVP_PCRD = join(REPO, "samples/20260726_S183-S185_RVP.pcrd");
const EXAMPLE = "20260726_S183-S185_RVP.zpcr";
/** Written by {@link makeDupe}: the example under its own name but a different size. */
const DUPE = join(REPO, "tools/.uishot/dupe", EXAMPLE);
/** Fixtures for the Instrument view's `.prcl.txt` picker — written at test time rather than
 * committed, since the point is the text form this app writes, not a captured artifact. */
const PRCL_TXT = join(REPO, "tools/.uishot/dupe/Gradient.prcl.txt");
const BAD_TXT = join(REPO, "tools/.uishot/dupe/not-a-protocol.txt");
/** A protocol the editor can actually hold — the Gradient fixture above deliberately can't be
 * represented (its `GOTO 4,39` names a step that doesn't exist), which is its own check. */
const EDITABLE_TXT = join(REPO, "tools/.uishot/dupe/Cycling.prcl.txt");
const EDITABLE_TXT_BODY =
  "[ProtocolRunDefinition version 06.00]\nMETHOD CALC;\nHOTLID 105,30;\nVOLUME 20;\n" +
  "TEMP 95.0,60;\nTEMP 95.0,10;\nTEMP 60.0,30;\nPLATEREAD #h3F;\nGOTO 2,39;\nEND;\n";
/** A plate CSV naming its dyes and nothing else — the format records no channels, so the only
 * way these get one is the run they are staged with (`Zpcr.channelForDye`). */
const PLATE_CSV = join(REPO, "tools/.uishot/dupe/Staged.plt.csv");
const PLATE_CSV_BODY =
  "# zpcrweb plate definition\r\n# vessel: BR Clear 8x12\r\n" +
  "Well,SampleType,Sample,FAM,Cy5\r\nA1,unknown,S1,TargetA,TargetB\r\n";
/** A gradient protocol, so the review is unmistakably *not* the loaded run's. */
const PRCL_TXT_BODY =
  "[ProtocolRunDefinition version 06.00]\nMETHOD CALC;\nHOTLID 105,30;\nVOLUME 25;\n" +
  "GRAD 50.0,60.0,30;\nPLATEREAD #h3F;\nGOTO 4,39;\nEND;\n";

/** The `.zpcr` a run gets the moment Start run is clicked, written at test time from the same
 * core call the app makes — a protocol, a plate and a name, with no `RunInfo.xml`, no plate reads
 * and no calibration set (`core/runSeed.ts`). */
const SEED_ZPCR = join(REPO, "tools/.uishot/dupe/20260802-Seeded_Run.zpcr");

/** A real run with its last two plate reads removed — the shape a cancelled run's archive has,
 * since nothing else in the files marks an abort (`usb.md` §7.8). Built rather than committed:
 * the point is the comparison, not a captured artifact. */
const SHORT_ZPCR = join(REPO, "tools/.uishot/dupe/20260725-Cut_Short.zpcr");

/** Write {@link SHORT_ZPCR} by deleting plate reads from a committed sample's own files. */
async function makeShortRun() {
  const { zpcrFromRunFiles, unzipArchive } = await import("../packages/core/dist/index.js");
  const files = unzipArchive(
    new Uint8Array(readFileSync(join(REPO, "samples/20260725_GRADIENTTEST.zpcr"))),
  );
  const reads = Object.keys(files)
    .filter((n) => /\.Plateread$/i.test(n))
    .sort();
  for (const name of reads.slice(-2)) delete files[name];
  const { bytes } = zpcrFromRunFiles(files, { fileName: "20260725-Cut_Short" });
  mkdirSync(dirname(SHORT_ZPCR), { recursive: true });
  writeFileSync(SHORT_ZPCR, Buffer.from(bytes));
}

/**
 * A run that stopped short of its protocol says so, in the two places that matter.
 *
 * The archive is a genuine 3-read gradient run with two reads deleted, so the app has to reach
 * the verdict the way it does in the wild — by counting `GOTO` loops in the protocol and
 * comparing (`runCompleteness`), with nothing in the file to tell it. The chip's assertion is
 * that **Incomplete** takes the date's slot rather than sitting beside it.
 */
async function incompleteRunChecks(chrome, origin) {
  console.log("\na run that stopped short");
  await makeShortRun();
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, SHORT_ZPCR);
  await waitFor(() => chipPresent(cdp, "Cut Short"), { what: "the short run's chip" });

  const chip = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".filechip__date")].map((e) => ({
         text: e.textContent.trim(),
         incomplete: e.classList.contains("filechip__date--incomplete"),
       })))`,
    )
    .then(JSON.parse);
  check(
    "the chip says Incomplete, in red, in place of the run's date",
    chip.length === 1 && chip[0].incomplete && /incomplete/i.test(chip[0].text),
    JSON.stringify(chip),
  );

  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");
  await waitFor(
    async () =>
      !!(await cdp.eval(`document.querySelector(".overview__incomplete")?.textContent ?? ""`)),
    { what: "the Overview's incomplete banner" },
  );
  const banner = await cdp.eval(
    `document.querySelector(".overview__incomplete")?.textContent?.trim() ?? ""`,
  );
  check(
    "the Overview banner states the arithmetic — 3 reads asked for, 1 present",
    /3 plate reads/.test(banner) && /holds 1/.test(banner),
    JSON.stringify(banner.slice(0, 160)),
  );

  // The complete original must not be accused: same protocol, all its reads.
  await loadFile(cdp, join(REPO, "samples/20260725_GRADIENTTEST.zpcr"));
  await waitFor(() => chipPresent(cdp, "GRADIENTTEST"), { what: "the complete run's chip" });
  const flagged = await cdp.eval(`document.querySelectorAll(".filechip__date--incomplete").length`);
  check("the complete run beside it is not flagged", flagged === 1, `${flagged} flagged chips`);
  cdp.close();
}

/** Write {@link SEED_ZPCR}. Built rather than committed: the point is what the app writes when a
 * run starts, not a captured artifact — and it is the only run file with nothing to plot. */
async function makeSeed() {
  const { planRun, parsePlateCsv, zpcrSeedArchive } = await import(
    "../packages/core/dist/index.js"
  );
  const runDefinition =
    "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,39;END;";
  const plate = parsePlateCsv(PLATE_CSV_BODY, { sourceName: "Staged.plt.csv" });
  const plan = planRun({ runDefinition, plate, name: "Seeded Run", plateName: "Staged" });
  const { bytes } = zpcrSeedArchive({
    experimentName: "Seeded Run",
    fileBaseName: "20260802-Seeded_Run",
    runDefinition,
    protocolName: "Cycling",
    plan,
  });
  mkdirSync(dirname(SEED_ZPCR), { recursive: true });
  writeFileSync(SEED_ZPCR, Buffer.from(bytes));
}

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

/** Click a `.viewselect` tab by its visible label — the Files/Instrument tabs (their own
 * `.segmented--*` groups, `ViewSelector.tsx`) as well as the main strip's. Scoped to `.viewselect`
 * rather than every `[role="tab"]` in the page, since a file chip is one too. */
const clickTab = (cdp, label) =>
  cdp.eval(`(() => { const t = [...document.querySelectorAll('.viewselect [role="tab"]')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      t?.click(); })()`);

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
 * The header (`useHeaderFit.ts`) collapses its own labels via `data-fit` when they don't fit a
 * narrow window, rather than overflowing. It measures against a callback ref, precisely because a
 * plain `useRef` once broke this silently: the header doesn't exist yet on the welcome screen
 * (`.app__brand` there, no tabs), so the first time it mounts — when a file loads — is a
 * transition the effect's `deps` (just the selected view) don't see if the view happens not to
 * change across that transition, which it doesn't on a first load. `ref.current` stayed `null`
 * forever, the `ResizeObserver` never attached, and the header overflowed at every width. Neither
 * Vitest (no DOM) nor `uishot.mjs` (only reports console errors, and a silently-overflowing
 * header logs none) would have caught that.
 */
async function headerFitChecks(chrome, origin) {
  console.log("\nheader fit");
  const cdp = await openPage(chrome.base, origin);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await loadFile(cdp, ZPCR);
  await sleep(500);

  // `.app__header` itself is a plain (non-scrolling) flex row — an overflowing child paints past
  // the box rather than growing `scrollWidth` there. `.app__views` (the tab strip) is the one
  // header child that actually is a scroll container (`overflow-x: auto`), so an uncollapsed
  // header shows up there as a strip too narrow to show its own tabs uncropped.
  const narrow = await cdp.eval(`(() => {
      const h = document.querySelector(".app__header");
      const views = h.querySelector(".app__views");
      return { fit: h.dataset.fit, overflow: views.scrollWidth - views.clientWidth };
    })()`);
  check(
    "a too-narrow header collapses instead of overflowing",
    narrow.fit !== "0" && narrow.overflow <= 1,
    `data-fit=${narrow.fit} overflow=${narrow.overflow}px`,
  );

  // The same `ResizeObserver` that has to catch the very first measurement also has to catch
  // every later resize — widening back out must un-collapse it.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);
  const wide = await cdp.eval(`document.querySelector(".app__header").dataset.fit`);
  check("widening the window restores the full header", wide === "0", `data-fit=${wide}`);

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

/**
 * A `.pcrd` that CFX saved with a hand-pinned threshold carries that number per fluorophore
 * (`threshold.md` §5.3), and loading such a run must seed the app's own override with it —
 * that single value is what makes this app reproduce the instrument's Cq exactly. Nothing on
 * screen distinguishes a seeded override from a coincidentally-similar automatic threshold
 * except the field's state, so this is checked rather than looked at.
 */
async function persistedThresholdChecks(chrome, origin, pw) {
  console.log("\npersisted .pcrd threshold");
  const cdp = await openPage(chrome.base, origin, `/#cfxPassword=${encodeURIComponent(pw)}`);
  await sleep(600);
  await loadFile(cdp, RVP_PCRD);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  // The file's own settings are seeded in an effect that runs after the first render, so the rail
  // shows automatic thresholds for a frame before the run's own values land.
  await waitFor(
    () => cdp.eval(`!!document.querySelector(".analysis__thresholds input.is-override")`),
    { what: "a seeded threshold override" },
  );

  const fields = await cdp.eval(`(() => {
    const d = [...document.querySelectorAll("details")]
      .find((d) => d.textContent.includes("Threshold"));
    if (!d) return null;
    d.open = true;
    return [...d.querySelectorAll("input[type=number]")].map((i) => ({
      label: i.getAttribute("aria-label"),
      value: i.value,
      override: i.className.includes("is-override"),
    }));
  })()`);
  const fam = fields?.find((f) => /^FAM threshold/.test(f.label ?? ""));
  check("the run's FAM threshold is seeded as an override", fam?.override === true, JSON.stringify(fam));
  check(
    "and it is the value the file persisted (92.02)",
    Math.abs(Number(fam?.value) - 92.0212554931641) < 0.51,
    fam?.value,
  );
  const auto = fields?.find((f) => /^Cy5 threshold/.test(f.label ?? ""));
  check(
    "a fluorophore the file left on auto is not overridden",
    auto?.override === false,
    JSON.stringify(auto),
  );

  // Leave IndexedDB as we found it. Every check shares one browser profile, so a run left behind
  // here is re-hydrated (and re-analysed) by every page opened afterwards — which is enough extra
  // work to push a later check's fixed-delay reads past their deadline. Checks that load a file
  // beyond the shared fixture clean it up.
  //
  // A chip's own ✕ only hides now (`FileBar.tsx`'s `HideButton`) — an actual delete lives in the
  // full files table (the "Files" tab, `FilesTableView.tsx`), so cleanup goes there instead. ZPCR
  // (the shared fixture, kept loaded across checks) is in there too by this point, so the RVP row
  // has to be picked out by name rather than just grabbing the first ✕. Every table row's ✕
  // always arms before it deletes, modified or not, so this takes two clicks.
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector(".filesview__row")`), { what: "the files table" });
  const clickRvpDelete = () =>
    cdp.eval(`(() => { const row = [...document.querySelectorAll(".filesview__row")]
      .find((r) => /RVP/.test(r.textContent));
      row?.querySelector(".ftbl__del")?.click(); })()`);
  await clickRvpDelete();
  await clickRvpDelete();
  await waitFor(
    () => cdp.eval(`![...document.querySelectorAll(".filesview__row")].some((r) => /RVP/.test(r.textContent))`),
    { what: "the RVP .pcrd to be deleted" },
  );
  await cdp.eval(`(() => { document.querySelector(".filesview__close")?.click(); })()`);
  await sleep(300);
  cdp.close();
}

/**
 * The Curves view's table mode: that clicking a header really re-orders the rows, that a second
 * click reverses it, and that the two invariants `CurveTable.sortRows` promises hold in the
 * rendered DOM — a well with no Cq stays at the bottom in *both* directions, and only the active
 * column is marked (`aria-sort`). All of it is state a screenshot can't verify: the same eight
 * rows in a different order look equally plausible either way.
 */
async function tableSortChecks(chrome, origin) {
  console.log("\ncurves table mode (sortable headers)");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  const toTable = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Table"); if (!b) return "missing"; b.click(); return "ok"; })()`,
  );
  check("the Curves rail offers Table mode", toTable === "ok");
  await waitFor(() => cdp.eval(`!!document.querySelector(".atbl")`), { what: "the analysis table" });

  /** The rendered rows' cells for one column, by header label. */
  const column = (label) =>
    cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".atbl thead th")];
      const i = heads.findIndex((h) => h.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (i < 0) return null;
      return [...document.querySelectorAll(".atbl tbody tr")].map((r) => r.cells[i].textContent.trim());
    })()`);
  const clickHead = (label) =>
    cdp.eval(`(() => {
      const h = [...document.querySelectorAll(".atbl thead th")]
        .find((h) => h.textContent.trim().startsWith(${JSON.stringify(label)}));
      if (!h) return "missing"; h.querySelector("button").click(); return "ok"; })()`);
  const sortedHeads = () =>
    cdp.eval(`[...document.querySelectorAll(".atbl thead th")]
        .filter((h) => h.getAttribute("aria-sort") !== "none")
        .map((h) => h.textContent.trim().replace(/[▲▼↕]/g, ""))`);

  const wellsBefore = await column("Well");
  check("table mode renders the run's rows", (wellsBefore?.length ?? 0) > 1, `${wellsBefore?.length} rows`);

  check("clicking a header sorts by that column", (await clickHead("Well")) === "ok");
  await sleep(200);
  const wellAsc = await column("Well");
  check(
    "the sorted column is the only one marked",
    JSON.stringify(await sortedHeads()) === '["Well"]',
    JSON.stringify(await sortedHeads()),
  );
  check(
    "Well sorts by plate position, not label text",
    JSON.stringify(wellAsc) === JSON.stringify([...wellAsc].sort(byWell)),
    (wellAsc ?? []).join(" "),
  );

  await clickHead("Well");
  await sleep(200);
  const wellDesc = await column("Well");
  check(
    "clicking the same header again reverses it",
    JSON.stringify(wellDesc) === JSON.stringify([...wellAsc].reverse()),
    (wellDesc ?? []).join(" "),
  );

  await clickHead("Cq");
  await sleep(200);
  const cqAsc = await column("Cq");
  const quantified = cqAsc.filter((v) => v !== "—");
  check(
    "Cq sorts numerically",
    JSON.stringify(quantified) === JSON.stringify([...quantified].sort((a, b) => a - b)),
    quantified.join(" "),
  );
  check("wells with no Cq sort last", noCqLast(cqAsc), cqAsc.join(" "));
  check(
    "sorting a new column moves the marker off the old one",
    JSON.stringify(await sortedHeads()) === '["Cq"]',
    JSON.stringify(await sortedHeads()),
  );

  // Reversing Cq must not float the unquantified wells to the top: they carry no number to be
  // the largest, so they stay parked at the bottom in both directions.
  await clickHead("Cq");
  await sleep(200);
  const cqDesc = await column("Cq");
  check(
    "reversing Cq reverses the quantified wells",
    JSON.stringify(cqDesc.filter((v) => v !== "—")) === JSON.stringify([...quantified].reverse()),
    cqDesc.join(" "),
  );
  check("wells with no Cq stay last when Cq is reversed", noCqLast(cqDesc), cqDesc.join(" "));

  // The Cq axis: a marker's position is the *only* thing that carries "early vs late" (the
  // number beside it is exact but not comparable at a glance), and an axis mis-scaled by one
  // cycle still looks entirely plausible in a screenshot.
  const axis = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll(".atbl tbody tr")].map((r) => ({
      cq: r.querySelector(".atbl__cq").textContent.trim(),
      left: r.querySelector(".atbl__cqmark")?.style.left ?? null,
    }));
    return { rows, title: document.querySelector(".atbl__cqaxis")?.title ?? "" };
  })()`);
  const cycles = Number(/of (\d+) cycles/.exec(axis.title)?.[1]);
  check("the Cq axis spans the run's cycle count", cycles > 0, axis.title);
  check(
    "every Cq is marked at its own cycle on that axis",
    axis.rows
      .filter((r) => r.cq !== "—")
      .every((r) => Math.abs(parseFloat(r.left) - ((Number(r.cq) - 1) / (cycles - 1)) * 100) < 0.5),
    axis.rows.map((r) => `${r.cq}@${r.left}`).join(" "),
  );
  check(
    "a well with no Cq gets an empty axis, not a marker at zero",
    axis.rows.filter((r) => r.cq === "—").every((r) => r.left === null),
    axis.rows.filter((r) => r.cq === "—").map((r) => String(r.left)).join(" "),
  );

    // End RFU is the instrument's own end-point number (`threshold.md` §7) and is deliberately
  // *not* ΔRFU: on a still-climbing well the two differ by hundreds of RFU, so a column that
  // silently mirrored the other one would look entirely reasonable on screen.
  await clickHead("End RFU");
  await sleep(200);
  const endAsc = await column("End RFU");
  const num = (v) => Number(String(v).replace(/[^-\d.]/g, ""));
  check(
    "End RFU sorts numerically",
    JSON.stringify(endAsc.map(num)) === JSON.stringify([...endAsc.map(num)].sort((a, b) => a - b)),
    endAsc.join(" "),
  );
  const deltas = await column("ΔRFU");
  check(
    "End RFU is a column of its own, not a copy of ΔRFU",
    endAsc.some((v, i) => Math.abs(num(v) - num(deltas[i])) > 1),
    endAsc.map((v, i) => `${v}/${deltas[i]}`).join(" "),
  );

  cdp.close();
}

/**
 * The Curves rail's Cq range filter: that its two handles really do bound the shown set, that
 * they can't cross, and — the part that isn't a plain min/max — that the top stop is where the
 * curves with *no* Cq live, so pulling the upper handle off it hides them and parking the lower
 * handle on it leaves only them.
 *
 * Checked in table mode because the rows carry the numbers being filtered on, so the assertion
 * is "exactly the rows whose Cq is in range" rather than a count. A screenshot can't show any of
 * it: fewer curves on a chart look like fewer curves however they were chosen.
 */
async function cqFilterChecks(chrome, origin) {
  console.log("\ncurves rail (Cq range filter)");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  await cdp.eval(
    `(() => { const b = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Table"); b && b.click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".atbl")`), { what: "the analysis table" });

  /** The Cq column as rendered — numbers as strings, "—" for a well that never crossed. */
  const cqs = () =>
    cdp.eval(`(() => {
      const heads = [...document.querySelectorAll(".atbl thead th")];
      const i = heads.findIndex((h) => h.textContent.trim().startsWith("Cq"));
      return [...document.querySelectorAll(".atbl tbody tr")].map((r) => r.cells[i].textContent.trim());
    })()`);
  /** Drive one handle the way a drag would: React reads the native value, so set it through the
   * prototype's setter and fire the same `input` event the browser does. */
  const drag = (which, v) =>
    cdp.eval(`(() => {
      const el = document.querySelector(".cq-range__input--" + ${JSON.stringify(which)});
      if (!el) return "missing";
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(${v}));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return "ok";
    })()`);
  const readout = () =>
    cdp.eval(`(document.querySelector(".cq-range__value") || { textContent: "missing" }).textContent.trim()`);
  const reset = () =>
    cdp.eval(`(() => { const b = document.querySelector(".cq-range__foot .rail__link");
      if (!b) return "missing"; b.click(); return "ok"; })()`);

  const all = await cqs();
  const noCq = all.filter((v) => v === "—").length;
  check("the rail offers a Cq range filter", (await readout()) === "all");
  check("the run has both quantified and unquantified rows", all.length > noCq && noCq > 0, `${all.length} rows, ${noCq} without Cq`);

  const top = await cdp.eval(`Number(document.querySelector(".cq-range__input--hi").max)`);
  const lastCycle = top - 1;

  // Upper handle off the top stop: the no-Cq rows go with it, and nothing above the bound stays.
  check("the upper handle moves", (await drag("hi", lastCycle - 10)) === "ok");
  // Wait for the filter to actually bite rather than for a fixed delay: how long the table takes
  // to re-render depends on how much else the page is hydrating, which is not this check's
  // business. (It used to be `sleep(200)`, and that made the check fail whenever an earlier check
  // had left an extra run in IndexedDB.)
  await waitFor(async () => (await cqs()).length < all.length, { what: "the Cq bound to apply" });
  const bounded = await cqs();
  check(
    "an upper bound keeps exactly the rows at or below it",
    bounded.every((v) => v !== "—" && Number(v) <= lastCycle - 10) &&
      bounded.length === all.filter((v) => v !== "—" && Number(v) <= lastCycle - 10).length,
    bounded.join(" "),
  );
  check("moving the upper handle off the top stop hides the no-Cq rows", !bounded.includes("—"));

  // Handles can't cross: pushing the lower one past the upper clamps it to the upper.
  await drag("lo", top);
  await sleep(200);
  check(
    "the lower handle clamps at the upper instead of crossing it",
    (await readout()) === `${lastCycle - 10}–${lastCycle - 10}`,
    await readout(),
  );

  check("the reset link restores the full range", (await reset()) === "ok");
  await waitFor(async () => (await cqs()).length === all.length, { what: "the reset to apply" });
  check("reset shows every row again", (await cqs()).length === all.length, await readout());

  // The top stop's other half: the lower handle parked there leaves only the no-Cq rows, which
  // is the "what never amplified?" question no other control in the rail can ask.
  await drag("lo", top);
  await sleep(200);
  const only = await cqs();
  check(
    "the lower handle on the top stop leaves only the no-Cq rows",
    only.length === noCq && only.every((v) => v === "—"),
    only.join(" "),
  );
  check("that state reads as its own thing, not a range", (await readout()) === "no Cq only", await readout());

  await reset();
  // Channel space has no Cq table of its own (see `CurvesView`'s `channelAnalysis`), so the
  // control is absent there rather than present and inert.
  await cdp.eval(
    `(() => { const b = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Channel"); b && b.click(); })()`,
  );
  await sleep(300);
  check(
    "channel mode has no Cq filter",
    (await cdp.eval(`!!document.querySelector(".cq-range")`)) === false,
  );

  cdp.close();
}

/** Compare two well labels the way the table does: row letter, then column *number*. */
function byWell(a, b) {
  return a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1));
}

/** True when every "—" (no Cq) sits after every quantified row. */
function noCqLast(cqs) {
  const first = (cqs ?? []).findIndex((v) => v === "—");
  return first < 0 || (cqs ?? []).slice(first).every((v) => v === "—");
}

/**
 * The Reference view's rail: that its chips really are the shared `ChipBar` (one interaction
 * contract everywhere — click toggles, double-click solos, hovering a disabled chip peeks at it)
 * rather than the bespoke per-chip "only" button they used to carry, and that the DARKDATA
 * overlay is offered exactly where it means something. None of it is visible to a screenshot:
 * peeking and soloing are both transient states of the plotted set.
 */
async function referenceChecks(chrome, origin) {
  console.log("\nreference view rail (shared chips + dark overlay)");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  await loadFile(cdp, ZPCR);
  await cdp.eval(`window.location.hash = "view=reference", undefined`);
  await tabBecomes(cdp, "Reference");
  await waitFor(() => cdp.eval(`!!document.querySelector(".reference .chanbar")`), {
    what: "reference rail",
  });

  /** The rail's own count line — the app's statement of what it plotted. */
  const stat = () => cdp.eval(`document.querySelector(".reference .rail__stat").textContent`);
  const curveCount = async () => Number(/^(\d+)/.exec((await stat()).trim())?.[1] ?? -1);
  /** The R1–R12 bar is the second `.chanbar` in the rail (Channels is the first). */
  const refChip = (n) =>
    `document.querySelectorAll(".reference .chanbar")[1].querySelectorAll(".chanchip")[${n}]`;
  const refOn = () =>
    cdp.eval(`[...document.querySelectorAll(".reference .chanbar")[1]
        .querySelectorAll(".chanchip")].filter((b) => b.getAttribute("aria-pressed") === "true").length`);
  /**
   * Move the real pointer over an element (or, with no selector, well away from the rail).
   * A synthesized `mouseover` is not enough here: React derives `onMouseEnter`/`onMouseLeave`
   * from the *pair* of over/out events plus `relatedTarget`, so only a genuine
   * `Input.dispatchMouseEvent` produces the enter/leave sequence the peek is built on.
   */
  const hover = async (sel) => {
    let x = 5;
    let y = 5;
    if (sel) {
      const box = await cdp.eval(`(() => { ${sel}.scrollIntoView({ block: "center" });
          const r = ${sel}.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      ({ x, y } = box);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  };

  // The unification itself: the old markup was a <div> chip wrapping a toggle plus an "only"
  // button. Every chip in the app is now the one `ChipBar` button.
  const onlyButtons = await cdp.eval(`document.querySelectorAll(".refchip__only").length`);
  const allButtons = await cdp.eval(`[...document.querySelectorAll(".reference .chanchip")]
      .every((c) => c.tagName === "BUTTON")`);
  check(
    "reference chips are plain ChipBar buttons, with no per-chip “only” button left",
    onlyButtons === 0 && allButtons,
    `${onlyButtons} only-buttons`,
  );

  const allCols = await refOn();
  const allCurves = await curveCount();

  // Double-click solos, the same gesture every other bar uses.
  await cdp.eval(`(${refChip(1)}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), undefined)`);
  await sleep(250);
  const soloCols = await refOn();
  const soloCurves = await curveCount();
  check(
    "double-clicking a reference column isolates it",
    soloCols === 1 && soloCurves < allCurves,
    `${allCols}→${soloCols} columns on, ${allCurves}→${soloCurves} curves`,
  );

  // Hovering one of the columns just turned off shows it again — but only while hovered.
  await hover(refChip(3));
  await sleep(250);
  const peeked = await curveCount();
  await hover(null);
  await sleep(250);
  const unpeeked = await curveCount();
  check(
    "hovering a disabled reference column peeks at it, and only while hovered",
    peeked > soloCurves && unpeeked === soloCurves,
    `${soloCurves} → ${peeked} (hovered) → ${unpeeked}`,
  );

  // The DARKDATA overlay: on in the Raw baseline, and inert in the factory-relative modes,
  // which have no factory value to plot a dark curve against.
  const clickSwitch = (label) =>
    cdp.eval(`(() => { const b = [...document.querySelectorAll(".reference .switch")]
        .find((s) => s.textContent.includes(${JSON.stringify(label)}));
        if (!b) return "missing"; b.click(); return "ok"; })()`);
  const clickBaseline = (label) =>
    cdp.eval(`(() => { const b = [...document.querySelectorAll(".reference .segmented__item")]
        .find((s) => s.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return "missing"; b.click(); return "ok"; })()`);

  check("the Reference rail offers a dark overlay switch", (await clickSwitch("Show dark")) === "ok");
  await sleep(300);
  const withDark = await stat();
  check(
    "Show dark overlays the run's DARKDATA channels in the Raw baseline",
    /\+ \d+ dark/.test(withDark),
    withDark.trim(),
  );

  // The factory overlay is a *drawing* toggle: the values behind it also drive the ΔRFU and
  // Drift % baselines, so hiding the line must not empty them (that would silently break both
  // modes). Turning it back on has to restore the line, not just the count.
  check("the Reference rail offers a factory overlay switch", (await clickSwitch("Show factory")) === "ok");
  await sleep(300);
  const factoryOff = await stat();
  await clickSwitch("Show factory");
  await sleep(300);
  const factoryOn = await stat();
  check(
    "Show factory hides and restores the factory line",
    /factory hidden/.test(factoryOff) && /\d+ factory/.test(factoryOn),
    `off: ${factoryOff.trim()} | on: ${factoryOn.trim()}`,
  );

  // X-axis mode: one line per (channel, column) over cycles, vs. one line per channel across
  // the columns, each point a mean over all cycles.
  // Restore every column first, so the two modes have visibly different series counts: cycle
  // mode draws one line per (channel, column), column mode one line per channel. (uPlot paints
  // its axis label onto the canvas, so the axis itself can't be read from the DOM.)
  await cdp.eval(`(document.querySelectorAll(".reference .rail__icon-btn")[1].click(), undefined)`);
  await sleep(300);
  const cycleAll = await curveCount();
  check("the Reference rail offers the Column x axis", (await clickBaseline("Column")) === "ok");
  await sleep(400);
  const colStat = await stat();
  const colCount = await curveCount();
  check(
    "Column mode collapses each column's curve into one line per channel",
    /reference columns/.test(colStat) && colCount < cycleAll && colCount > 0,
    `${cycleAll} curves over cycles → ${colCount} lines over columns`,
  );
  // ΔRFU still works in column mode — which it would not if hiding the factory line had
  // emptied the array the baseline reads.
  await clickBaseline("ΔRFU");
  await sleep(400);
  const colDelta = await stat();
  check(
    "column mode still baselines against the factory values",
    /ΔRFU from factory/.test(colDelta),
    colDelta.trim(),
  );
  await clickBaseline("Raw");
  await sleep(300);
  check("the Reference rail returns to the Cycle x axis", (await clickBaseline("Cycle")) === "ok");
  await sleep(400);

  check("the Reference rail offers the ΔRFU baseline", (await clickBaseline("ΔRFU")) === "ok");
  await sleep(300);
  const deltaStat = await stat();
  const note = await cdp.eval(
    `document.querySelector(".reference .rail__note")?.textContent ?? ""`,
  );
  check(
    "dark drops out of the factory-relative baselines, and says why",
    !/dark/.test(deltaStat) && /Raw-baseline only/.test(note),
    `${deltaStat.trim()} | note: ${note.trim() ? "shown" : "missing"}`,
  );

  // Min/max bands: unlike the two overlays these are baseline-agnostic (the envelope rides the
  // same {scale, shift} the line does), so they must draw under ΔRFU — but only on the cycle
  // axis, since a column point is a run mean with no per-read spread of its own. Counting the
  // overlay's band paths is the only way to see them: uPlot draws the lines to a canvas, and
  // the bands are the SVG layer on top of it.
  const bandCount = () =>
    cdp.eval(`(() => { const svg = document.querySelector(".reference .u-over svg");
        return svg ? svg.firstElementChild.children.length : -1; })()`);
  const noBands = await bandCount();
  check("the Reference rail offers a min/max band switch", (await clickSwitch("Min/max band")) === "ok");
  await sleep(400);
  const deltaBands = await bandCount();
  check(
    "min/max bands draw under the factory-relative baseline too",
    noBands === 0 && deltaBands > 0,
    `${noBands} → ${deltaBands} band paths`,
  );
  await clickBaseline("Column");
  await sleep(400);
  const colBands = await bandCount();
  const colNote = await cdp.eval(
    `[...document.querySelectorAll(".reference .rail__note")].map((n) => n.textContent).join(" ")`,
  );
  check(
    "column mode drops the bands, and says why",
    colBands === 0 && /Cycle-axis only/.test(colNote),
    `${deltaBands} → ${colBands} band paths | note: ${/Cycle-axis only/.test(colNote) ? "shown" : "missing"}`,
  );

  cdp.close();
}

async function passwordChecks(chrome, origin, pw) {
  console.log("\npassword handling");

  // A locked run, before any password: the prompt gates the *content*, and the header keeps its
  // strip with every file tab greyed out. The old behaviour dropped the strip entirely, which
  // made unlocking look like the tabs were something the file had to earn — and moved the rest
  // of the header sideways as it appeared.
  const locked = await openPage(chrome.base, origin);
  await emptyReload(locked, origin);
  await locked.eval(`localStorage.removeItem("zpcr:pltdPassword")`);
  await emptyReload(locked, origin);
  await loadFile(locked, PCRD).catch(() => {});
  await waitFor(() => locked.eval(`!!document.querySelector(".app__gate")`), {
    what: "the password prompt",
  });
  const lockedStrip = await locked
    .eval(
      `JSON.stringify([...document.querySelectorAll('.viewselect [role="tab"]')]
         .map((b) => ({ label: b.textContent.trim(), off: b.disabled })))`,
    )
    .then(JSON.parse);
  check(
    "a locked run keeps the tab strip, with every file tab disabled",
    lockedStrip.length === 9 &&
      lockedStrip.filter((t) => t.off).length === 7 &&
      !lockedStrip.find((t) => t.label === "Instrument").off &&
      !lockedStrip.find((t) => t.label === "Files").off,
    JSON.stringify(lockedStrip),
  );
  locked.close();

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
    // Anchor on the viewer having caught up with the click before touching the mode buttons:
    // until it has, the toolbar still describes the *previous* entry, whose mode may already be
    // Text — which would satisfy the wait below without anything having been selected yet, and
    // leave the check watching a viewer that then resets to this file's own default mode.
    await waitFor(
      () =>
        cdp.eval(
          `document.querySelector('.raw__fname')?.textContent.trim() === ${JSON.stringify(entry)}`,
        ),
      { what: `${entry} in the raw viewer` },
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
  await tabBecomes(solo, "Raw");
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

/**
 * The `.alf` run report's decoded view (`alf.md`, `components/raw/DecodedAlf.tsx`).
 *
 * A screenshot shows the table; what it can't show is that the numbers in it are the *derived*
 * ones rather than fields copied out of the file, which is the whole reason the view exists:
 *
 * - the plate-read count matches the archive's own `.Plateread` entries (§7.5 — the check that
 *   would catch a missing read, and the one claim that spans two file types at once);
 * - "took" is the next step's start minus this one's (§7.4), so a 10 s hold reads as the ~20 s
 *   it really occupied — a column equal to the hold column would mean the derivation was lost;
 * - the fourth column of the file (§8) is *absent*, deliberately, and a future edit that helpfully
 *   adds it back should fail here rather than ship a number nobody can interpret.
 */
async function alfViewChecks(chrome, origin) {
  console.log("\n.alf run report");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, ZPCR);
  await cdp.eval(`window.location.hash = "view=raw", undefined`);
  await tabBecomes(cdp, "Raw");

  // Pick the `.alf` out of the file list by extension — its name carries the run's timestamp.
  await waitFor(
    () =>
      cdp.eval(
        `!!([...document.querySelectorAll('.raw__item')].find(b => /\\.alf$/i.test(b.textContent.trim())))`,
      ),
    { what: "the .alf entry in the file list" },
  );
  const plateReads = await cdp.eval(
    `[...document.querySelectorAll('.raw__item')].filter(b => /\\.Plateread$/i.test(b.textContent.trim())).length`,
  );
  await cdp.eval(
    `[...document.querySelectorAll('.raw__item')].find(b => /\\.alf$/i.test(b.textContent.trim())).click()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector('.decoded__alf tbody tr')`), {
    what: "the decoded execution log",
  });

  const log = await cdp
    .eval(
      `JSON.stringify((() => {
         // The headings are uppercased by CSS, not in the markup — match on the real text.
         const head = [...document.querySelectorAll('.decoded__alf thead th')].map(t => t.textContent.trim());
         const rows = [...document.querySelectorAll('.decoded__alf tbody tr')].map(r =>
           [...r.querySelectorAll('td')].map(c => c.textContent.trim()));
         const col = (name) => head.findIndex(h => h.toLowerCase() === name.toLowerCase());
         const cell = (r, name) => r[col(name)];
         const steps = rows.filter(r => r.length === head.length);
         return {
           head,
           mode: document.querySelector('.raw__modes .segmented__item.is-active')?.textContent.trim(),
           reads: steps.filter(r => cell(r, "READ") !== "").length,
           lastRead: steps.filter(r => cell(r, "READ") !== "").map(r => cell(r, "READ")).pop(),
           // A 10 s hold in this run's cycling loop, and what it actually occupied.
           tenSecond: steps.filter(r => cell(r, "HOLD") === "0:10").map(r => cell(r, "TOOK")),
           stages: [...new Set(steps.map(r => cell(r, "STAGE")))].length,
         };
       })())`,
    )
    .then(JSON.parse);

  check(
    "a .alf opens on its decoded run report, not a hex dump",
    log.mode === "Decoded",
    log.mode,
  );
  check(
    "the execution log's plate reads are 1:1 with the archive's .Plateread files (alf.md §7.5)",
    log.reads === plateReads && log.lastRead === String(plateReads),
    `${log.reads} logged / ${plateReads} files, last index ${log.lastRead}`,
  );
  // A 10 s hold never occupies *less* than 10 s, and mostly occupies more — the surplus is the
  // ramp, which exists in this column only because it is differenced timestamps rather than a
  // copy of the file's hold field. Not "always more": this run's first pass holds 95 °C right
  // after a 60 s hold at 95 °C, so there is no ramp to pay for and it comes to exactly 0:10.
  const holds = log.tenSecond.map((t) => {
    const [m, s] = t.split(":");
    return Number(m) * 60 + Number(s);
  });
  check(
    "a step's duration is measured from the next step's start, not read off the hold (alf.md §7.4)",
    holds.length > 0 &&
      holds.every((s) => s >= 10) &&
      holds.filter((s) => s > 10).length > holds.length / 2,
    `${holds.length} ten-second holds, took ${[...new Set(log.tenSecond)].sort().join(", ")}`,
  );
  check(
    "the unexplained fourth column is not presented as a ramp time (alf.md §8)",
    !log.head.some((h) => /ramp/i.test(h)),
    log.head.join(" "),
  );
  cdp.close();
}

/**
 * The thermal profile under a run's Protocol tab (`components/protocol/ThermalProfileChart.tsx`
 * over core's `alfThermalProfile`, `alf.md` §7.6).
 *
 * The trace itself is on a canvas and only a screenshot can judge it; what's assertable — and
 * what would break silently — is the read numbering. Every read is a point but only as many
 * numbers as fit are drawn, so the invariant is that the *endpoints* survive whatever thinning
 * happens: a plot whose last number isn't the run's read count is one that quietly lost reads.
 * Both ends of that are exercised here, on a 3-read run where nothing is thinned and a 45-read
 * one where most of it is. Plus: the section appears only for a run that carries a report at all.
 */
async function thermalProfileChecks(chrome, origin) {
  console.log("\nthermal profile");
  const cdp = await openPage(chrome.base, origin);

  /** Load `file`, open its Protocol tab, and report what the profile section drew. */
  const profileOf = async (file, { expectChart = true } = {}) => {
    await emptyReload(cdp, origin);
    await loadFile(cdp, file);
    await cdp.eval(`window.location.hash = "view=protocol", undefined`);
    await tabBecomes(cdp, "Protocol");
    if (expectChart) {
      await waitFor(() => cdp.eval(`!!document.querySelector(".thermal canvas")`), {
        what: "the thermal profile chart",
      });
    }
    return cdp
      .eval(
        `JSON.stringify((() => ({
           section: !!document.querySelector(".thermal"),
           canvas: !!document.querySelector(".thermal canvas"),
           empty: !!document.querySelector(".thermal .chart__empty"),
           // uPlot draws its own axes on the canvas; the only SVG text in the box is a read number.
           labels: [...document.querySelectorAll(".thermal svg text")].map((t) => t.textContent),
         }))())`,
      )
      .then(JSON.parse);
  };

  const grad = await profileOf(GRADIENT_ZPCR);
  check(
    "a run's Protocol tab plots what the block actually did (alf.md §7.6)",
    grad.section && grad.canvas && !grad.empty,
    JSON.stringify({ section: grad.section, canvas: grad.canvas, empty: grad.empty }),
  );
  check(
    "every plate read is numbered when they all fit — 3 reads, 3 numbers",
    JSON.stringify(grad.labels) === JSON.stringify(["1", "2", "3"]),
    grad.labels.join(","),
  );

  // 45 reads in ~800 px: most numbers have to go, but the first and last never may.
  const dense = await profileOf(ZPCR);
  check(
    "a dense run thins the read numbers rather than smearing them",
    dense.labels.length > 1 && dense.labels.length < 45,
    `${dense.labels.length} of 45 drawn`,
  );
  check(
    "…keeping the first and last, so the read count stays readable off the plot (§7.5)",
    dense.labels[0] === "1" && dense.labels[dense.labels.length - 1] === "45",
    `${dense.labels[0]} … ${dense.labels[dense.labels.length - 1]}`,
  );
  check(
    "…and numbering them in order",
    dense.labels.every((l, i) => i === 0 || Number(l) > Number(dense.labels[i - 1])),
    dense.labels.join(","),
  );

  // A `.pcrd` carries the run's protocol but never the instrument's report (alf.md §1), so there
  // is nothing measured to plot — the tab keeps the protocol and drops the section entirely.
  const pcrd = await profileOf(PCRD, { expectChart: false });
  check(
    "a .pcrd, which carries no run report, gets no profile section at all (alf.md §1)",
    !pcrd.section,
    JSON.stringify(pcrd),
  );
  cdp.close();
}

/** True once a chip whose label matches `text` is in the file bar. */
const chipPresent = (cdp, text) =>
  cdp.eval(
    `[...document.querySelectorAll(".filechip__name")].some((n) => /${text}/.test(n.textContent))`,
  );

/**
 * The Instrument view's run staging: which loaded files make up the run that would be started.
 *
 * All of it is state a screenshot can't judge, and the selection rules are the substance —
 * one run at a time, a `.prcl.txt`/plate file overriding half of it, a run deselected once both
 * halves are overridden because it then contributes nothing (`state/useRunStaging.ts`). Getting
 * one of those wrong would silently stage a run out of the wrong files, which is the failure
 * mode that matters here. Also: that a `.prcl.txt` loaded through the app's ordinary load button
 * arrives as a chip and goes where it can be used, and that Start run appears only with an
 * instrument attached.
 */
async function instrumentRunChecks(chrome, origin) {
  console.log("\ninstrument run staging");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  // Earlier checks leave their own files in IndexedDB, so start from a known empty bar rather
  // than from whatever the suite happened to load last — the selection rules below are about
  // *which* chips are on, and a stray one makes every count meaningless.
  await emptyReload(cdp, origin);
  await loadFile(cdp, ZPCR);
  await sleep(800);
  await cdp.eval(
    `window.location.hash = "file=20260720_FirstQualification.zpcr&view=protocol", undefined`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__blockhead")`), {
    what: "the Protocol tab's thermal protocol section",
  });

  // The Protocol tab is where a `.prcl.txt` comes from in the first place — the button is beside
  // the protocol section's heading, not the archive download on Overview.
  const dlLabel = await cdp.eval(
    `(document.querySelector(".overview__blockhead .raw__download") || {})
       .getAttribute?.("aria-label") ?? "missing"`,
  );
  check(
    "The Protocol tab offers the thermal protocol as a .prcl.txt download",
    /\.prcl\.txt/.test(dlLabel),
    dlLabel,
  );

  // The Protocol tab is also where the *reading* of the protocol lives (`protocol.md`) — the
  // per-directive gloss that makes an ASCII program reviewable without knowing the language.
  // Checked here rather than by screenshot because the point is that the decode is present and
  // paired with the right line. The Instrument view deliberately doesn't repeat it (see below).
  const notes = await cdp.eval(`(() => {
    const lines = [...document.querySelectorAll(".overview__block .decoded__protoline")].map((l) => ({
      num: l.querySelector(".decoded__protonum").textContent.trim(),
      text: l.querySelector(".decoded__prototext").textContent.trim(),
      note: l.querySelector(".decoded__protonote")?.textContent.trim() || "",
    }));
    return { lines, annotated: lines.length > 0 && lines.every((l) => l.note.length > 0) };
  })()`);
  const hotlid = notes.lines.find((l) => l.text.startsWith("HOTLID"));
  const read = notes.lines.find((l) => l.text.startsWith("PLATEREAD"));
  const goto = notes.lines.find((l) => l.text.startsWith("GOTO"));
  check(
    "every directive on the Protocol tab is annotated with what it does",
    notes.annotated && /Heated lid at 105/.test(hotlid?.note ?? "") && hotlid.num === "",
    JSON.stringify(hotlid),
  );
  check(
    "PLATEREAD's operand is decoded as a scan mask, not shown raw",
    /all 6 channels, step-and-repeat/.test(read?.note ?? ""),
    read?.note,
  );
  check(
    "GOTO names the step it returns to, and the pass count that isn't its operand",
    /Return to step 2 \(TEMP 95\.0,10\)/.test(goto?.note ?? "") && /45 passes/.test(goto?.note ?? ""),
    `${goto?.num}: ${goto?.text} → ${goto?.note}`,
  );

  await cdp.eval(`window.location.hash = "view=instrument", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".devrun")`), { what: "the run panel" });
  await sleep(300);

  /** The staged run as the panel renders it: each half's source file and override badge. */
  const staged = () =>
    cdp.eval(`(() => {
      const parts = [...document.querySelectorAll(".devrun__part")].map((p) => ({
        title: p.querySelector(".devrun__parttitle").textContent.trim(),
        source: p.querySelector(".devrun__source")?.textContent.replace("override", "").trim() || null,
        override: !!p.querySelector(".devrun__badge"),
        text: p.textContent,
      }));
      return {
        protocol: parts.find((p) => p.title === "Protocol") || null,
        plate: parts.find((p) => p.title === "Plate") || null,
        chips: [...document.querySelectorAll(".filebar--multi .filechip")].map((c) => ({
          name: c.querySelector(".filechip__name").textContent.trim(),
          // Two different kinds of on: the primary selection (cyan, is-active — the run, and
          // the file the rest of the app is showing) and an auxiliary override staged over it
          // (magenta, is-staged).
          on: c.classList.contains("is-active") || c.classList.contains("is-staged"),
          primary: c.classList.contains("is-active"),
        })),
      };
    })()`);

  // The file bar is still the file bar — the Instrument view just reads it as a selection.
  const first = await staged();
  check(
    "the Instrument view keeps the app's file bar, in multi-select mode",
    first.chips.length === 1 && first.chips[0].on,
    JSON.stringify(first.chips),
  );
  check(
    "a selected run supplies both halves of the staged run",
    /METHOD CALC/.test(first.protocol.text) &&
      !first.protocol.override &&
      /8×12/.test(first.plate.text),
    JSON.stringify({ proto: first.protocol.source, plate: first.plate.source }),
  );

  // The staged protocol is the program and nothing else: no per-directive gloss. It shares this
  // panel's width with a plate map, and what the language *means* is a question Overview answers
  // (checked above) — here the question is what would be sent, so every line is still numbered
  // as the instrument numbers it, setup directives included (no number).
  const staging = await cdp.eval(`(() => {
    const lines = [...document.querySelectorAll(".devrun__part .decoded__protoline")].map((l) => ({
      num: l.querySelector(".decoded__protonum").textContent.trim(),
      text: l.querySelector(".decoded__prototext").textContent.trim(),
      note: l.querySelector(".decoded__protonote")?.textContent.trim() || "",
      scan: l.querySelector(".decoded__protoscan")?.textContent.trim() || "",
    }));
    return { lines, annotated: lines.some((l) => l.note.length > 0) };
  })()`);
  const stagedLid = staging.lines.find((l) => l.text.startsWith("HOTLID"));
  const stagedGoto = staging.lines.find((l) => l.text.startsWith("GOTO"));
  const stagedRead = staging.lines.find((l) => l.text.startsWith("PLATEREAD"));
  check(
    "the staged protocol lists the directives themselves, with no decode column",
    staging.lines.length > 0 &&
      !staging.annotated &&
      stagedLid?.num === "" &&
      /^GOTO/.test(stagedGoto?.text ?? "") &&
      Number(stagedGoto?.num) > 0,
    JSON.stringify({ annotated: staging.annotated, lid: stagedLid, goto: stagedGoto }),
  );
  // …with one exception: a scan mask is a packed byte, so `#h3F` alone doesn't say what would be
  // read. It keeps its decode on a line of its own, and nothing else picks one up.
  check(
    "…except PLATEREAD, whose packed operand keeps its channels and scan mode",
    /^all 6 channels, step-and-repeat$/.test(stagedRead?.scan ?? "") &&
      staging.lines.filter((l) => l.scan).length === 1,
    JSON.stringify({ read: stagedRead, withScan: staging.lines.filter((l) => l.scan).length }),
  );

  // Start run belongs to the instrument, not the panel, so it is absent until one is attached.
  const startWhenIdle = await cdp.eval(`!!document.querySelector(".instrument__start")`);
  check("Start run appears only with an instrument connected", startWhenIdle === false);

  // One name is collected here, not two: what the run's *file* is called is derived at the click
  // and never asked (`state/useRunNaming.ts`), so a second field would be a second way to say the
  // same thing — and one that could disagree with the file already written.
  const names = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".devrun__name")].map((l) => ({
         label: l.querySelector(".devrun__namelabel").textContent.replace(/\\*/g, "").trim(),
         value: l.querySelector("input").value,
         missing: l.querySelector("input").classList.contains("is-missing"),
         readOnly: l.querySelector("input").readOnly,
       })))`,
    )
    .then(JSON.parse);
  check(
    "the panel collects exactly one name — the experiment's, empty and marked required",
    names.length === 1 &&
      names[0].label === "Experiment name" &&
      names[0].value === "" &&
      names[0].missing &&
      !names[0].readOnly,
    JSON.stringify(names),
  );

  // A `.prcl.txt` goes in through the ordinary load button, not a picker of its own.
  mkdirSync(dirname(PRCL_TXT), { recursive: true });
  writeFileSync(PRCL_TXT, PRCL_TXT_BODY);
  await loadFile(cdp, PRCL_TXT);
  await waitFor(() => chipPresent(cdp, "Gradient"), { what: "the .prcl.txt chip" });
  await sleep(400);
  const loadedTab = await activeTab(cdp);
  // Opening a protocol shows what it *is*, not the staging panel: a `.prcl.txt` is a document
  // first, and Instrument is where you go when you mean to start a run.
  check("loading a .prcl.txt lands on the Overview view", loadedTab === "Overview", loadedTab);

  // A protocol file is also a document, not only an input: it has an Overview of its own, which
  // the tab strip has to actually offer — the failure being a tab that is enabled but renders
  // nothing, or a file forced to one view whatever you click. Everything the page shows
  // there comes from core's decode (`protocol.md`), which is what the listing check confirms:
  // this fixture's `GOTO 4,39` names a step that doesn't exist in a 3-step program, so it is
  // also the degrade-gracefully case (a target it can't name, still counted correctly).
  const protoTabs = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll('.viewselect [role="tab"]')]
         .map(b => ({ label: b.textContent.trim(), off: b.disabled })))`,
    )
    .then(JSON.parse);
  check(
    "a .prcl.txt enables Overview, Protocol, Raw and Instrument (and the file-independent Files tab), nothing else",
    protoTabs.filter((t) => !t.off).map((t) => t.label).join(",") ===
      "Files,Overview,Protocol,Raw,Instrument",
    JSON.stringify(protoTabs.filter((t) => !t.off).map((t) => t.label)),
  );

  // Overview itself, for a protocol file, is a minimal identity card (the same info table every
  // other kind's Overview leads with) — the protocol's own detail lives on the Protocol tab.
  const infoTable = () =>
    cdp.eval(`(() => {
      const dl = document.querySelector(".overview__infotable");
      const info = {};
      if (dl) {
        const dts = [...dl.querySelectorAll("dt")];
        const dds = [...dl.querySelectorAll("dd")];
        dts.forEach((dt, i) => { info[dt.textContent.trim()] = dds[i].textContent.trim(); });
      }
      return info;
    })()`);
  const overviewInfo = await infoTable();
  check(
    "…and its Overview shows just the file identity, nothing decoded",
    Object.keys(overviewInfo).join(",") === "Type,Filename,Last modified" &&
      /Gradient/.test(overviewInfo.Filename ?? ""),
    JSON.stringify(overviewInfo),
  );

  await clickTab(cdp, "Protocol");
  const protoTab = await tabBecomes(cdp, "Protocol");
  const protoInfo = await infoTable();
  const protoLines = await cdp.eval(`[...document.querySelectorAll(".decoded__protoline")].map((l) => ({
    num: l.querySelector(".decoded__protonum").textContent.trim(),
    text: l.querySelector(".decoded__prototext").textContent.trim(),
    note: l.querySelector(".decoded__protonote").textContent.trim(),
  }))`);
  const protoOverview = { tiles: protoInfo, lines: protoLines };
  check(
    "…and its Protocol tab reports the protocol's own settings, from the decode not the text",
    protoTab === "Protocol" &&
      protoOverview.tiles.Lid === "105 °C" &&
      protoOverview.tiles.Volume === "25 µL" &&
      protoOverview.tiles.Steps === "3" &&
      /all 6 channels/.test(protoOverview.tiles.Scan ?? ""),
    JSON.stringify(protoOverview.tiles),
  );
  const grad = protoOverview.lines.find((l) => l.text.startsWith("GRAD"));
  const strayGoto = protoOverview.lines.find((l) => l.text.startsWith("GOTO"));
  check(
    "…listing every directive with its reading, including a GOTO whose target doesn't exist",
    grad.num === "1" &&
      /Gradient 50–60 °C/.test(grad.note) &&
      /Return to step 4/.test(strayGoto.note) &&
      /40 passes/.test(strayGoto.note) &&
      !/\(/.test(strayGoto.note),
    `${grad.note} | ${strayGoto.note}`,
  );

  // A `.prcl.txt` has no separate "name" the way a `.zpcr` does — the info table's Filename row
  // is its only identity, so that's what `StandaloneProtocolOverview`'s own Rename button edits
  // (Overview is the minimal identity card; Protocol, where the check above just left the page,
  // has no Filename row of its own). Renamed and renamed straight back, since the chip label the
  // rest of this block clicks on is derived from this same filename.
  await clickTab(cdp, "Overview");
  await tabBecomes(cdp, "Overview");
  const protoFilename = () =>
    cdp.eval(`(() => {
      const dts = [...document.querySelectorAll(".overview__infotable dt")];
      const dds = [...document.querySelectorAll(".overview__infotable dd")];
      const i = dts.findIndex((dt) => dt.textContent.trim() === "Filename");
      return i < 0 ? null : dds[i].textContent;
    })()`);
  const renameProto = async (value) => {
    await cdp.eval(`document.querySelector(".overview__renamebtn").click()`);
    await sleep(50);
    await cdp.eval(
      `(() => { const el = document.querySelector(".overview__filename-input");
         el.focus();
         const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
         setter.call(el, ${JSON.stringify(value)});
         el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await sleep(200);
    await cdp.eval(`document.querySelector(".overview__filename-input").blur()`);
  };
  await renameProto("Gradient-renamed.prcl.txt");
  await waitFor(async () => (await protoFilename()) === "Gradient-renamed.prcl.txt", {
    what: "the protocol file's renamed Filename row",
  });
  check(
    "a .prcl.txt's filename can be renamed too, from its own Rename button",
    (await protoFilename()) === "Gradient-renamed.prcl.txt",
    await protoFilename(),
  );
  await renameProto("Gradient.prcl.txt");
  await waitFor(async () => (await protoFilename()) === "Gradient.prcl.txt", {
    what: "the protocol file's name restored",
  });

  // Back where the rest of this block expects to be.
  await cdp.eval(`(() => [...document.querySelectorAll('.viewselect [role="tab"]')]
      .find((b) => b.textContent.trim() === "Instrument").click())()`);
  await tabBecomes(cdp, "Instrument");

  // In this view the cyan chip is the *run being staged*, not the active file: a loaded
  // `.prcl.txt` is the file the app is on (it has an Overview of its own), but what the bar has
  // to name here is the run it is being staged against. So the run reads as the primary
  // selection and the protocol as an auxiliary one, and the two colours mean two different
  // things rather than one washed-out "selected".
  const roles = await cdp
    .eval(
      `JSON.stringify({
         primary: [...document.querySelectorAll(".filechip.is-active .filechip__name")]
           .map((n) => n.textContent.trim()),
         staged: [...document.querySelectorAll(".filechip.is-staged .filechip__name")]
           .map((n) => n.textContent.trim()),
       })`,
    )
    .then(JSON.parse);
  check(
    "the staged run is the bar's one primary chip, the .prcl.txt an auxiliary one",
    roles.primary.length === 1 &&
      /FirstQualification/.test(roles.primary[0]) &&
      roles.staged.some((n) => /Gradient/.test(n)),
    JSON.stringify(roles),
  );

  // Loading it stages it: the headline flow is "load a protocol, see it against the run you
  // already had", so the file joins the selection rather than replacing it.
  const overridden = await staged();
  check(
    "a loaded .prcl.txt overrides the run's protocol and is badged as an override",
    /GRAD 50/.test(overridden.protocol.text) && overridden.protocol.override,
    JSON.stringify({ source: overridden.protocol.source, badge: overridden.protocol.override }),
  );
  check(
    "…while the run still supplies the plate, and stays selected",
    !overridden.plate.override &&
      /8×12/.test(overridden.plate.text) &&
      overridden.chips.filter((c) => c.on).length === 2,
    JSON.stringify(overridden.chips),
  );

  // Overriding the *other* half too leaves the run supplying neither — but it stays selected,
  // because it is still the instrument whose calibration set gives a plate CSV its channels.
  await loadFile(cdp, PLTD);
  await waitFor(() => chipPresent(cdp, "QuickPlate"), { what: "the .pltd chip" });
  await sleep(500);
  const both = await staged();
  const onNames = both.chips.filter((c) => c.on).map((c) => c.name);
  check(
    "a run stays selected alongside overrides of both halves",
    onNames.length === 3 && onNames.some((n) => /FirstQualification/.test(n)),
    JSON.stringify(onNames),
  );
  check(
    "…and both halves are badged as overrides",
    both.protocol.override && both.plate.override,
    JSON.stringify({ proto: both.protocol.override, plate: both.plate.override }),
  );

  // Tapping a staged override releases its slot. The run is not one of those: it is the app's
  // primary selection, which is never empty (`useRunStaging.ts`).
  const tap = (pattern) =>
    cdp.eval(
      `(() => { [...document.querySelectorAll(".filechip__main")]
          .find((b) => ${pattern}.test(b.textContent)).click(); })()`,
    );
  await tap("/Gradient/");
  await sleep(300);
  const off = await staged();
  check(
    "tapping a selected .prcl.txt deselects it",
    !off.chips.find((c) => /Gradient/.test(c.name)).on &&
      off.chips.filter((c) => c.on).length === 2,
    JSON.stringify(off.chips.filter((c) => c.on).map((c) => c.name)),
  );
  await tap("/FirstQualification/");
  await sleep(300);
  const stillRun = await staged();
  const runChip = stillRun.chips.find((c) => /FirstQualification/.test(c.name));
  const plateChip = stillRun.chips.find((c) => /QuickPlate/.test(c.name));
  check(
    "tapping the selected run leaves it selected — the primary selection is never empty",
    runChip.primary && /METHOD CALC/.test(stillRun.protocol.text) && !stillRun.protocol.override,
    JSON.stringify(stillRun.chips),
  );
  // …and the two highlights say which is which: the run is the app's ordinary primary selection,
  // the plate is an override staged over it.
  check(
    "the run is the primary chip, the override an auxiliary one",
    runChip.primary && plateChip.on && !plateChip.primary && stillRun.plate.override,
    JSON.stringify({ run: runChip, plate: plateChip }),
  );

  // A staged `.plt.csv` borrows the run's dye→channel mapping. The format records dye names
  // only, so parsed on its own every channel is unknown; pairing it with a run is what resolves
  // them, and getting this wrong shows dyes with no colour and no channel grouping.
  writeFileSync(PLATE_CSV, PLATE_CSV_BODY);
  await loadFile(cdp, PLATE_CSV);
  await waitFor(() => chipPresent(cdp, "Staged"), { what: "the .plt.csv chip" });
  await sleep(500);
  const csvStaged = await cdp.eval(`(() => {
    const part = [...document.querySelectorAll(".devrun__part")]
      .find((p) => p.querySelector(".devrun__parttitle").textContent.trim() === "Plate");
    return {
      chips: [...part.querySelectorAll(".plate__chip")].map((c) => c.textContent.trim()),
      unknown: !!part.querySelector(".plate__chip--unknown"),
      source: part.querySelector(".devrun__source")?.textContent.replace("override", "").trim(),
    };
  })()`);
  check(
    "a staged .plt.csv takes its channels from the run it is paired with",
    /Staged\.plt\.csv/.test(csvStaged.source) &&
      !csvStaged.unknown &&
      csvStaged.chips.some((c) => /FAM\s*Ch1/.test(c)) &&
      csvStaged.chips.some((c) => /Cy5\s*Ch4/.test(c)),
    JSON.stringify(csvStaged),
  );

  // The case the three-slot model exists for: a run staged *alongside* overrides of both halves.
  // It supplies neither, but it is still the instrument, and that is what gives the plate CSV its
  // channels — so the panel names it rather than leaving a chip lit for no visible reason.
  await tap("/Gradient/");
  await sleep(400);
  const allThree = await cdp.eval(`(() => {
    const part = [...document.querySelectorAll(".devrun__part")]
      .find((p) => p.querySelector(".devrun__parttitle").textContent.trim() === "Plate");
    return {
      on: [...document.querySelectorAll(
        ".filebar--multi :is(.filechip.is-active, .filechip.is-staged) .filechip__name",
      )].map((n) => n.textContent.trim()),
      unknown: !!part.querySelector(".plate__chip--unknown"),
      chips: [...part.querySelectorAll(".plate__chip")].map((c) => c.textContent.trim()),
      channelsFrom: /channels from/.test(part.textContent),
      hint: document.querySelector(".devrun__hint").textContent.trim(),
    };
  })()`);
  check(
    "a run can be staged with both halves overridden, and still lends its channels",
    allThree.on.length === 3 &&
      !allThree.unknown &&
      allThree.chips.some((c) => /FAM\s*Ch1/.test(c)) &&
      allThree.channelsFrom,
    JSON.stringify(allThree),
  );
  check(
    "…and the panel names it by experiment name, as the rest of the app does",
    /^instrument: FirstQualification$/.test(allThree.hint),
    allThree.hint,
  );

  // Only one run at a time: selecting a second replaces the first.
  await loadFile(cdp, PCRD);
  // `Luna.noRT`, not `Luna_noRT`: a chip shows the run's *name*, and the derivation reads the
  // filename's `_` as the space the user typed (see `experiment.ts`).
  await waitFor(() => chipPresent(cdp, "Luna.noRT"), { what: "the .pcrd chip" });
  await sleep(500);
  const clickRun = (pattern) =>
    cdp.eval(
      `(() => { [...document.querySelectorAll(".filechip__main")]
          .find((b) => ${pattern}.test(b.textContent)).click(); })()`,
    );
  await clickRun("/FirstQualification/");
  await sleep(300);
  await clickRun("/Luna noRT/");
  await sleep(400);
  const runs = await staged();
  const runsOn = runs.chips.filter((c) => c.on).map((c) => c.name);
  check(
    "selecting a second run replaces the first — only one can be staged",
    runsOn.filter((n) => /FirstQualification|Luna noRT/.test(n)).length === 1 &&
      runsOn.some((n) => /Luna noRT/.test(n)),
    JSON.stringify(runsOn),
  );

  // A chip's icon is two independent claims: its *shape* is what the file is (core's
  // `fileCategory`), its *colour* is whether it's encrypted. All five chips are loaded by now —
  // two runs, two plates in different encodings, one protocol — so this is the one place the
  // "an encoding is not a kind" rule can be checked: the `.pltd` and the `.plt.csv` must draw the
  // same icon *while* differing in colour, and a run and a protocol must not draw a plate.
  const icons = await cdp.eval(`(() => {
    const out = {};
    for (const chip of document.querySelectorAll(".filebar .filechip")) {
      const name = chip.querySelector(".filechip__name").textContent.trim();
      const icon = chip.querySelector(".filechip__icon");
      out[name] = { shape: icon.querySelector("svg").innerHTML, cls: icon.className };
    }
    return out;
  })()`);
  const shapeOf = (n) => Object.entries(icons).find(([k]) => new RegExp(n).test(k))?.[1];
  const [zpcr, pcrd, pltd, csv, prcl] = ["FirstQualification", "Luna noRT", "QuickPlate", "Staged", "Gradient"].map(shapeOf);
  check(
    "the two plate encodings share one plate icon, in whatever colour their encryption earns",
    pltd.shape === csv.shape && pltd.cls !== csv.cls && /--decrypted/.test(pltd.cls) && /--none/.test(csv.cls),
    JSON.stringify({ pltd: pltd.cls, csv: csv.cls, same: pltd.shape === csv.shape }),
  );
  check(
    "…and a run, a plate and a protocol are three different shapes",
    zpcr.shape === pcrd.shape &&
      new Set([zpcr.shape, pltd.shape, prcl.shape]).size === 3,
    JSON.stringify({ runsAlike: zpcr.shape === pcrd.shape, distinct: new Set([zpcr.shape, pltd.shape, prcl.shape]).size }),
  );

  // Garbage in reports itself rather than arriving as an unusable chip.
  writeFileSync(BAD_TXT, "<?xml version=\"1.0\"?>\n<protocol2 />\n");
  const before = await cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  await setFileInput(cdp, 'input[type="file"]', BAD_TXT);
  await waitFor(() => cdp.eval(`!!document.querySelector(".app__error")`), {
    what: "the rejection notice",
  });
  const rejected = await cdp.eval(`document.querySelector(".app__error").textContent`);
  const after = await cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  check(
    "a .txt that isn't a protocol is rejected rather than loaded",
    /not a thermal protocol/i.test(rejected) && after === before,
    rejected,
  );
  cdp.close();
}


/**
 * Type into the Overview header's name field and commit it — a rename, which is also the cheapest
 * way to make a file *modified* (see {@link deleteConfirmChecks}). The two halves are separate
 * turns on purpose: the field commits on blur from the *committed* draft state, so blurring in the
 * same tick as the input event would read the value React hasn't applied yet — which real typing
 * never does.
 */
async function setExperimentName(cdp, value) {
  await cdp.eval(
    // `focus()` first because the commit is on blur, and blurring an element that was never
    // focused fires nothing at all — the field would keep the text and store none of it.
    `(() => { const el = document.querySelector(".overview__name");
       el.focus();
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await sleep(200);
  await cdp.eval(`document.querySelector(".overview__name").blur()`);
}

/**
 * Rename the loaded file itself: open the Filename row's editable field (the toolbar's Rename
 * button) and commit a new value — the other identity a `.zpcr` carries, distinct from
 * {@link setExperimentName}'s stored run name. Ids hash name+size, so this is also what exercises
 * {@link ZpcrStore.renameFile}'s id migration.
 */
async function renameFile(cdp, value) {
  await cdp.eval(`document.querySelector(".overview__renamebtn").click()`);
  await sleep(50);
  await cdp.eval(
    `(() => { const el = document.querySelector(".overview__filename-input");
       el.focus();
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await sleep(200);
  await cdp.eval(`document.querySelector(".overview__filename-input").blur()`);
}

/**
 * What a run is called, and where that name comes from.
 *
 * The file bar stopped showing file names: a chip is now a run's *name* over its start date, and
 * no format has a field for the former (`experiment.ts`) — so the name is derived from the
 * filename, overridden by the format's own when it has one, and overridden again by whatever is
 * typed into the Overview header, which is stored in the archive's `zpcrweb.json` and therefore
 * has to survive a reload. Each of those is a silent failure otherwise: a name that renders but
 * doesn't stick looks identical to one that does until the tab is closed.
 *
 * Also here because it is the same "one file, no archive" story: a Biomeme run's Raw tab, which
 * shows the JSON document itself rather than the empty archive it has instead.
 */
/**
 * The file a run has between Start run and its first plate read: everything it *does* hold reads
 * normally, and the three tabs whose data does not exist yet are greyed out rather than rendering
 * an empty frame that looks broken (`App`'s `runViews`).
 */
async function runSeedChecks(chrome, origin) {
  console.log("\na just-started run's file");
  await makeSeed();
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, SEED_ZPCR);
  await waitFor(() => chipPresent(cdp, "Seeded Run"), { what: "the seeded run's chip" });

  const strip = await cdp
    .eval(
      `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.viewselect [role="tab"]')]
         .map((b) => [b.textContent.trim(), !b.disabled])))`,
    )
    .then(JSON.parse);
  check(
    "Curves, Reference and Calibration are off — the run has no readings yet",
    strip.Curves === false && strip.Reference === false && strip.Calibration === false,
    JSON.stringify(strip),
  );
  check(
    "Overview, Protocol, Plates and Raw stay on — those it does have",
    strip.Overview && strip.Protocol && strip.Plates && strip.Raw,
    JSON.stringify(strip),
  );

  // The name came out of the archive's own zpcrweb.json, which is what the run deposits on the
  // instrument too — so the chip reads the run's name rather than its filename.
  const chip = await cdp.eval(`document.querySelector(".filechip__name")?.textContent ?? ""`);
  check("the seeded run states its own name", chip === "Seeded Run", JSON.stringify({ chip }));

  await cdp.eval(`window.location.hash = "view=protocol", undefined`);
  await tabBecomes(cdp, "Protocol");
  const steps = await cdp.eval(`document.querySelectorAll(".decoded__prototext").length`);
  check("its protocol is there to read", steps > 0, `${steps} protocol lines`);
  cdp.close();
}

async function experimentNameChecks(chrome, origin) {
  console.log("\nexperiment names");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");

  // "Run date" and "Filename" are rows of the info table now, not their own headline elements
  // (see `OverviewView`'s `infoRows`) — found by label rather than a dedicated class, since the
  // table has no per-row classes to hang a selector on.
  const headline = () =>
    cdp
      .eval(
        `JSON.stringify((() => {
           const dl = document.querySelector(".overview__infotable");
           const info = {};
           if (dl) {
             const dts = [...dl.querySelectorAll("dt")];
             const dds = [...dl.querySelectorAll("dd")];
             dts.forEach((dt, i) => { info[dt.textContent.trim()] = dds[i].textContent.trim(); });
           }
           return {
             name: document.querySelector(".overview__name")?.value ?? null,
             when: info["Run date"] ?? null,
             file: info["Filename"] ?? null,
             chip: document.querySelector(".filechip__name")?.textContent ?? null,
             chipDate: document.querySelector(".filechip__date")?.textContent ?? null,
           };
         })())`,
      )
      .then(JSON.parse);

  const first = await headline();
  check(
    "an unnamed run is named from its filename, without the date/serial prefix",
    first.name === "S183-S185 RVP" && first.chip === "S183-S185 RVP",
    JSON.stringify(first),
  );
  // RunStartTime is `Mon, 27 Jul 2026 01:12:47 GMT`; the app renders local time, so the exact
  // string depends on the runner's zone — what must hold is that it is compact and that the
  // chip and the headline agree.
  check(
    "the run start shows as a compact local timestamp, on the chip and the headline alike",
    /^\d{1,2}\/\d{1,2}\/\d{2} \d{1,2}:\d{2}(am|pm)$/.test(first.when ?? "") &&
      first.chipDate === first.when,
    JSON.stringify(first),
  );
  check(
    "the file name moves below the headline rather than disappearing",
    first.file === EXAMPLE,
    JSON.stringify(first),
  );

  const setName = (value) => setExperimentName(cdp, value);

  // Type a name: it must reach the chip, and — the part that matters — survive a reload, which
  // it can only do by having been written into the archive's own zpcrweb.json.
  await setName("Renamed RVP");
  await waitFor(() => chipPresent(cdp, "Renamed RVP"), { what: "the renamed chip" });
  const named = await headline();
  check("a typed name replaces the derived one everywhere", named.name === "Renamed RVP", JSON.stringify(named));

  // The archive rewrite is rate-limited but writes the first edit immediately
  // (`analysisPersist.ts`), so a reload is enough — no minute of waiting.
  await sleep(700);
  await cdp.send("Page.navigate", { url: `${origin}#file=${EXAMPLE}&view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(async () => (await headline()).name !== null, { what: "the reloaded headline" });
  const reloaded = await headline();
  check(
    "the name survives a reload — it went into the file, not this browser",
    reloaded.name === "Renamed RVP",
    JSON.stringify(reloaded),
  );

  // Clearing it is meaningful: the run goes back to its derived name rather than to blank.
  await setName("  ");
  await waitFor(() => chipPresent(cdp, "S183-S185 RVP"), { what: "the derived name to come back" });
  const cleared = await headline();
  check(
    "clearing the name reverts to the derived one rather than leaving it blank",
    cleared.name === "S183-S185 RVP",
    JSON.stringify(cleared),
  );

  // Renaming the file itself is a different field from the run name above: it edits
  // `LoadedFile.name` (and, since ids hash name+size, the file's id) rather than the archive's
  // stored `experimentName`. A *stored* name (as opposed to the derived one `cleared` left
  // showing, which is itself computed from the filename and so would change right along with
  // it) is the only way to prove the two stayed independent.
  await setName("Stored RVP");
  await waitFor(() => chipPresent(cdp, "Stored RVP"), { what: "the re-stored name" });
  const renamedName = EXAMPLE.replace(/\.zpcr$/, "-renamed.zpcr");
  await renameFile(cdp, renamedName);
  // Unlike the run-name checks above, the chip text (the run's *name*) doesn't change here, so
  // it can't be what's waited on — the Filename row itself is the only observable that moves.
  await waitFor(async () => (await headline()).file === renamedName, { what: "the Filename row to update" });
  const renamed = await headline();
  check(
    "renaming the file updates the Filename row",
    renamed.file === renamedName,
    JSON.stringify(renamed),
  );
  check(
    "…without touching the run's own stored name",
    renamed.name === "Stored RVP",
    JSON.stringify(renamed),
  );
  await sleep(300); // the rename's IndexedDB writes are async (`ZpcrStore.renameFile`)
  await cdp.send("Page.navigate", { url: `${origin}#file=${renamedName}&view=overview` });
  await tabBecomes(cdp, "Overview");
  const reloadedRename = await headline();
  check(
    "the renamed file — and its new id — survive a reload",
    reloadedRename.file === renamedName && reloadedRename.name === "Stored RVP",
    JSON.stringify(reloadedRename),
  );
  // Clear the stored name again so the chip goes back to containing "S183" — the substring the
  // rest of this function's chip clicks below still key off.
  await setName("");
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the derived name to come back" });

  // A Biomeme run names itself, and its Raw tab is the JSON document rather than an archive.
  await loadFile(cdp, BIOMEME);
  await waitFor(() => chipPresent(cdp, "2024-01-17-22220147"), { what: "the Biomeme chip" });
  check(
    "a Biomeme run uses the name the format itself carries",
    await chipPresent(cdp, "2024-01-17-22220147"),
  );
  await cdp.eval(`window.location.hash = "view=raw", undefined`);
  await tabBecomes(cdp, "Raw");
  const raw = await cdp
    .eval(
      `JSON.stringify({
         fname: document.querySelector(".raw__fname")?.textContent ?? null,
         label: [...document.querySelectorAll(".segmented__item")].map(b => b.textContent.trim()),
         body: (document.querySelector(".raw__dump")?.textContent ?? "").slice(0, 40),
         list: document.querySelectorAll(".raw__list").length,
       })`,
    )
    .then(JSON.parse);
  check(
    "a Biomeme run has a Raw tab showing its JSON, in the standalone (no file list) viewer",
    raw.fname === "biomeme-2024-01-17.json" &&
      raw.label.includes("JSON") &&
      raw.list === 0 &&
      /"id"\s*:/.test(raw.body),
    JSON.stringify(raw),
  );

  // The tab strip is static: the same nine tabs whatever the file is, with the ones this file
  // has no answer for *disabled* rather than removed (`ViewSelector`'s `enabled` prop). Only a
  // browser can show this — it is a claim about two different files' headers being the same
  // shape, and the failure it guards against (tabs appearing and disappearing under the pointer
  // as the selection moves) is invisible to any single-file check.
  const strip = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll('.viewselect [role="tab"]')]
           .map(b => ({ label: b.textContent.trim(), off: b.disabled })))`,
      )
      .then(JSON.parse);
  const offLabels = (s) => s.filter((t) => t.off).map((t) => t.label);
  const bio = await strip();
  check(
    "a Biomeme run keeps all nine tabs, greying out the two it can't answer",
    bio.length === 9 && offLabels(bio).join(",") === "Reference,Calibration",
    JSON.stringify(bio),
  );

  // Back to the .zpcr loaded above: the same nine tabs, none of them off — so the strip's shape
  // really is file-independent, and the greying above is about capability rather than layout.
  await cdp.eval(
    `(() => { [...document.querySelectorAll(".filechip__main")]
        .find((b) => /S183/.test(b.textContent)).click(); })()`,
  );
  await waitFor(
    async () => (await strip()).every((t) => !t.off),
    { what: "the .zpcr's tabs to all enable" },
  );
  const run = await strip();
  check(
    "switching back to a .zpcr re-enables them in place, with the strip unchanged",
    run.length === 9 && run.map((t) => t.label).join(",") === bio.map((t) => t.label).join(","),
    JSON.stringify(run),
  );
  cdp.close();
}

/**
 * Hiding a chip from the bar, and deleting a file for real, in the full files table.
 *
 * A chip's ✕ only ever hides now (`FileSettings.visible`) — the file stays loaded, in IndexedDB,
 * and in the full files table opened from the bar's own toggle. The table is where a file is
 * actually deleted, and its ✕ always arms first (a red waste bin) regardless of whether the file
 * carries edits — the click after that is the one that deletes. The bar still wears the "unsaved"
 * dot on a modified chip — that part didn't move.
 *
 * All of it is state a screenshot can't judge: whether hiding really left the file in IndexedDB
 * (a reload not bringing it back would be a real delete in disguise), whether the modified flag
 * outlived a reload (it must — the stale copy is the one on disk), whether the first click on the
 * ✕ really didn't delete, or whether downloading the file left it any easier to delete (it
 * shouldn't — every row asks twice alike).
 */
async function deleteConfirmChecks(chrome, origin) {
  console.log("\ndelete confirmation");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });

  const chips = () => cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  const clickHide = () =>
    cdp.eval(`(() => { document.querySelector(".filebar .filechip__del").click(); })()`);
  const openTable = () => clickTab(cdp, "Files");
  const tableRows = () => cdp.eval(`document.querySelectorAll(".filesview__row").length`);
  const clickTableCheckbox = () =>
    cdp.eval(`(() => { document.querySelector(".filesview__checkcol input").click(); })()`);
  const clickTableDelete = () =>
    cdp.eval(`(() => { document.querySelector(".ftbl__del").click(); })()`);
  const tableDel = () =>
    cdp.eval(
      `(() => { const btn = document.querySelector(".ftbl__del");
         if (!btn) return "null";
         return JSON.stringify({ armed: btn.classList.contains("is-armed") }); })()`,
    ).then((v) => (v === "null" ? null : JSON.parse(v)));
  /** The chip's own state: modified dot only — it no longer arms. */
  const chip = () =>
    cdp
      .eval(
        `(() => { const c = document.querySelector(".filebar .filechip");
           if (!c) return "null";
           const dot = c.querySelector(".filechip__moddot");
           return JSON.stringify({
             modified: c.classList.contains("is-modified"),
             bin: !!c.querySelector(".filechip__del svg"),
             dot: getComputedStyle(dot).backgroundColor,
           }); })()`,
      )
      .then((v) => (v === "null" ? null : JSON.parse(v)));

  const untouched = await chip();
  check(
    "an unedited file wears no dot and an ordinary ✕",
    untouched.modified === false && !untouched.bin && /rgba\(0, 0, 0, 0\)|transparent/.test(untouched.dot),
    JSON.stringify(untouched),
  );

  // The chip's ✕ only hides — the file stays loaded, and shows up (unchecked) in the full table.
  await clickHide();
  await waitFor(async () => (await chips()) === 0, { what: "the chip to hide" });
  check("…and its ✕ takes it off the bar without deleting it", (await chips()) === 0);
  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the hidden file's table row" });
  const hiddenChecked = await cdp.eval(`document.querySelector(".filesview__checkcol input").checked`);
  check("the hidden file's row is unchecked in the table", hiddenChecked === false);

  // Checking it back on brings the chip back.
  await clickTableCheckbox();
  await waitFor(async () => (await chips()) === 1, { what: "the chip to come back" });
  check("re-checking the table row shows the chip again", (await chips()) === 1);

  // Even an unedited file's table ✕ arms first — every row asks twice, not just a modified one.
  await clickTableDelete();
  const untouchedArmed = await tableDel();
  await waitFor(async () => (await tableRows()) === 1, { what: "the row to still be there" });
  check(
    "an unedited file's table ✕ arms instead of deleting on the first click",
    untouchedArmed.armed && (await tableRows()) === 1,
    JSON.stringify(untouchedArmed),
  );
  await clickTableDelete();
  await waitFor(async () => (await tableRows()) === 0, { what: "the unedited file to delete" });
  check("…and the second click deletes it", (await tableRows()) === 0);
  await cdp.eval(`(() => { document.querySelector(".filesview__close")?.click(); })()`);

  // Now edit one: a rename is the cheapest thing that changes what a download would contain.
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip again" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");
  await setExperimentName(cdp, "Edited RVP");
  await waitFor(() => chipPresent(cdp, "Edited RVP"), { what: "the renamed chip" });
  const dirty = await chip();
  check(
    "editing a file lights the modified dot",
    dirty.modified === true && !/rgba\(0, 0, 0, 0\)|transparent/.test(dirty.dot),
    JSON.stringify(dirty),
  );

  // The flag is about the copy on disk, so it has to outlive this browser session.
  await sleep(700); // the archive rewrite is immediate but asynchronous (`analysisPersist.ts`)
  await cdp.send("Page.navigate", { url: `${origin}#file=${EXAMPLE}&view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(async () => (await chip())?.modified === true, { what: "the flag after a reload" });
  check("the modified state survives a reload", (await chip()).modified === true);

  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the edited file's table row" });
  await clickTableDelete();
  const armed = await tableDel();
  await waitFor(async () => (await tableRows()) === 1, { what: "the row to still be there" });
  check(
    "the first click on an edited file's table ✕ arms it instead of deleting",
    armed.armed && (await tableRows()) === 1,
    JSON.stringify(armed),
  );

  await clickTableDelete();
  await waitFor(async () => (await tableRows()) === 0, { what: "the confirmed delete" });
  check("the second click deletes", (await tableRows()) === 0);
  await cdp.eval(`(() => { document.querySelector(".filesview__close")?.click(); })()`);

  // Download it: the edits are on disk now, but the ✕ still asks twice — that never depended on
  // the modified flag in the first place.
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip once more" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");
  await setExperimentName(cdp, "Saved RVP");
  await waitFor(async () => (await chip()).modified === true, { what: "the modified flag" });
  await cdp.eval(`(() => { document.querySelector(".overview__toolbar .overview__downloadbtn").click(); })()`);
  await waitFor(async () => (await chip()).modified === false, { what: "the flag to clear" });
  check("downloading the file clears the modified state", (await chip()).modified === false);
  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the saved file's table row" });
  await clickTableDelete();
  const savedArmed = await tableDel();
  check(
    "…and its ✕ still arms first, rather than deleting on one click now that it's saved",
    savedArmed.armed && (await tableRows()) === 1,
    JSON.stringify(savedArmed),
  );
  await clickTableDelete();
  await waitFor(async () => (await tableRows()) === 0, { what: "the confirmed delete" });
  check("…so the second click deletes it", (await tableRows()) === 0);
  cdp.close();
}


/**
 * The protocol editor (`components/protocol/`, `protocol.md` §10).
 *
 * What a screenshot can't show and the core suite can't reach: that a click on a row opens a
 * form for *that* directive, that committing it rewrites the file (not just the view), that the
 * +/− pair renumbers the program around a GOTO, that undo/redo walk the same history the buttons
 * do, and that a protocol the builder can't represent is refused an editor rather than silently
 * rewritten. The serialization itself is core's and is asserted there
 * (`test/protocolBuilder.test.ts`) — these are the checks about the *interaction*.
 */
async function protocolEditorChecks(chrome, origin) {
  console.log("\nprotocol editor");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  mkdirSync(dirname(EDITABLE_TXT), { recursive: true });
  writeFileSync(EDITABLE_TXT, EDITABLE_TXT_BODY);
  writeFileSync(PRCL_TXT, PRCL_TXT_BODY);
  await loadFile(cdp, EDITABLE_TXT);
  await waitFor(() => chipPresent(cdp, "Cycling"), { what: "the editable .prcl.txt chip" });
  await clickTab(cdp, "Protocol");
  await tabBecomes(cdp, "Protocol");

  /** Every directive as listed, in order — the same rows in both modes. */
  const lines = () =>
    cdp.eval(`[...document.querySelectorAll(".decoded__protoline")].map((l) => ({
      num: l.querySelector(".decoded__protonum").textContent.trim(),
      text: l.querySelector(".decoded__prototext").textContent.trim(),
    }))`);
  const program = async () => (await lines()).map((l) => l.text).join(" ");
  const editBtn = () =>
    cdp.eval(`(() => { const b = [...document.querySelectorAll(".overview__blocktools button")]
        .find((x) => /^(Edit|Done)$/.test(x.textContent.trim()));
       return b ? JSON.stringify({ label: b.textContent.trim(), off: b.disabled, why: b.title }) : "null"; })()`)
      .then((v) => (v === "null" ? null : JSON.parse(v)));
  const clickButton = (label) =>
    cdp.eval(`(() => { const b = [...document.querySelectorAll(".overview__blocktools button")]
        .find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
       if (b) b.click(); return !!b; })()`);
  /** Click the row whose directive text starts with `prefix`. */
  const clickRow = (prefix) =>
    cdp.eval(`(() => { const l = [...document.querySelectorAll(".protoedit__line")]
        .find((x) => x.querySelector(".decoded__prototext").textContent.trim().startsWith(${JSON.stringify(prefix)}));
       const b = l && l.querySelector(".protoedit__rowbtn");
       if (b) b.click(); return !!b; })()`);
  const rowTool = (prefix, cls) =>
    cdp.eval(`(() => { const l = [...document.querySelectorAll(".protoedit__line")]
        .find((x) => x.querySelector(".decoded__prototext").textContent.trim().startsWith(${JSON.stringify(prefix)}));
       const b = l && l.querySelector(${JSON.stringify(cls)});
       if (b) b.click(); return !!b; })()`);
  /** The open form's labelled lines — label, current value, and the units beside it. */
  const formLines = () =>
    cdp.eval(`[...document.querySelectorAll(".stepform__popover .stepform__line")].map((l) => ({
      label: l.querySelector(".stepform__label").textContent.trim(),
      value: (l.querySelector("input, select") || {}).value ?? null,
      units: l.querySelector(".stepform__units").textContent.trim(),
    }))`);
  const setField = (label, value) =>
    cdp.eval(`(() => {
      const line = [...document.querySelectorAll(".stepform__popover .stepform__line")]
        .find((l) => l.querySelector(".stepform__label").textContent.trim() === ${JSON.stringify(label)});
      const el = line && line.querySelector("input, select");
      if (!el) return false;
      const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true; })()`);
  const commitForm = () =>
    cdp.eval(`(() => { const b = document.querySelector(".stepform__ok");
       if (b) b.click(); return !!b; })()`);
  const formOpen = () => cdp.eval(`!!document.querySelector(".stepform__popover")`);
  /** Put the open form away between checks. `hidePopover()` rather than a click: the *dismissal*
   *  has its own check below, and driving it by hand here would make every check after it depend
   *  on where the popover happened to land. Guarded, because React may already have taken the
   *  element out of the top layer, and `hidePopover()` on a non-popover throws. */
  const closeForm = async () => {
    if (!(await formOpen())) return;
    // Wait for it to actually be in the top layer first: the element renders one frame before the
    // effect that calls `showPopover`, and hiding a popover that isn't up yet does nothing.
    await waitFor(() => cdp.eval(`!!document.querySelector(".stepform__popover:popover-open")`), {
      what: "the form to finish opening",
    });
    await cdp.eval(`(() => { const p = document.querySelector(".stepform__popover:popover-open");
       if (p) p.hidePopover(); })()`);
    await waitFor(async () => !(await formOpen()), { what: "the form to close" });
  };
  /** Each group of directives as drawn: the lines inside one click target, and its +/− pair. */
  const groups = () =>
    cdp.eval(`JSON.stringify([...document.querySelectorAll(".protoedit__line")].map((g) => ({
      lines: [...g.querySelectorAll(".decoded__prototext")].map((t) => t.textContent.trim()),
      tools: [...g.querySelectorAll(".protoedit__iconbtn")].map((b) => b.textContent.trim()),
    })))`).then(JSON.parse);

  const before = await program();
  check(
    "a .prcl.txt's Protocol tab lists the program and offers an Edit button",
    (await editBtn())?.label === "Edit" && (await editBtn())?.off === false && /GOTO 2,39;/.test(before),
    JSON.stringify({ btn: await editBtn(), before }),
  );

  // Nothing is clickable until Edit is pressed — reading a protocol must stay reading it. The rows
  // are the *same* rows either way, so what says "not yet" is that clicking one opens nothing.
  await clickRow("TEMP");
  await sleep(200);
  check("…and no row opens a form before Edit is pressed", (await formOpen()) === false);

  /** Where each directive's text sits, to the pixel — the geometry Edit must not disturb. */
  const textLefts = () =>
    cdp.eval(`JSON.stringify([...document.querySelectorAll(".decoded__prototext")]
      .map((t) => Math.round(t.getBoundingClientRect().left)))`).then(JSON.parse);
  const readingLefts = await textLefts();

  await clickButton("Edit");
  await waitFor(async () => (await editBtn())?.label === "Done", { what: "edit mode" });
  check("Edit turns into Done", (await editBtn())?.label === "Done");

  // Reading and editing are the same listing, so the program must not shift when the +/− buttons
  // appear: their gutter is reserved while reading.
  const editingLefts = await textLefts();
  check(
    "…and the program doesn't move when the editing controls appear",
    JSON.stringify(readingLefts) === JSON.stringify(editingLefts) && readingLefts.length > 0,
    JSON.stringify({ reading: readingLefts.slice(0, 4), editing: editingLefts.slice(0, 4) }),
  );

  // A row's form is verb-specific: a TEMP gets Temperature and Duration with their units fixed
  // beside them, never the raw operand string.
  await clickRow("TEMP 60.0,30");
  await waitFor(formOpen, { what: "the step form" });
  const tempForm = await formLines();
  check(
    "clicking a TEMP row opens a Temperature/Duration form with units shown, not text",
    tempForm.some((l) => l.label === "Temperature" && l.value === "60" && l.units === "°C") &&
      tempForm.some((l) => l.label === "Duration" && l.value === "30" && /seconds/.test(l.units)),
    JSON.stringify(tempForm),
  );

  await setField("Temperature", "58");
  await commitForm();
  await waitFor(async () => /TEMP 58\.0,30;/.test(await program()), { what: "the edited step" });
  check("committing the form rewrites that directive", /TEMP 58\.0,30;/.test(await program()));
  check("…and closes the form", (await formOpen()) === false);

  // The edit is in the *file*, not just the view: reload from IndexedDB and it's still there.
  await cdp.send("Page.reload", {});
  await sleep(600);
  await waitFor(() => chipPresent(cdp, "Cycling"), { what: "the chip after reload" });
  await clickTab(cdp, "Protocol");
  await tabBecomes(cdp, "Protocol");
  check(
    "an edit is written to the file as it's made, with no Done required",
    /TEMP 58\.0,30;/.test(await program()),
    await program(),
  );

  await clickButton("Edit");
  await waitFor(async () => (await editBtn())?.label === "Done", { what: "edit mode again" });
  // Undo reaches back to the file as this editing session found it — the reload above ended the
  // previous session's history, which is the point of restarting it when the file changes
  // underneath the editor.
  const baseline = await program();

  // Insert renumbers everything below it, and the GOTO that pointed past the insertion follows
  // its step rather than its number (`ProtocolBuilder.withInsertedStep`).
  await rowTool("TEMP 95.0,60", ".protoedit__iconbtn--ins");
  await waitFor(formOpen, { what: "the new-step form" });
  await setField("Temperature", "50");
  await setField("Duration", "120");
  await commitForm();
  await waitFor(async () => /TEMP 50\.0,120;/.test(await program()), { what: "the inserted step" });
  const inserted = await lines();
  check(
    "+ inserts a step below, renumbering the rest and repointing the GOTO",
    inserted.map((l) => l.text).join(" ").includes("TEMP 95.0,60; TEMP 50.0,120;") &&
      inserted.some((l) => l.text === "GOTO 3,39;") &&
      inserted.filter((l) => l.num).map((l) => l.num).join(",") === "1,2,3,4,5,6",
    JSON.stringify(inserted),
  );

  // Delete puts it back, and the GOTO comes back with it.
  await rowTool("TEMP 50.0,120", ".protoedit__iconbtn--del");
  await waitFor(async () => !/TEMP 50\.0,120/.test(await program()), { what: "the step to go" });
  check("− deletes a step and renumbers back", /GOTO 2,39;/.test(await program()), await program());

  // Undo/redo walk the same history — three edits back to the file as loaded.
  await clickButton("↶ Undo");
  await waitFor(async () => /TEMP 50\.0,120/.test(await program()), { what: "the undone delete" });
  check("Undo restores the deleted step", /TEMP 50\.0,120;/.test(await program()));
  await clickButton("↷ Redo");
  await waitFor(async () => !/TEMP 50\.0,120/.test(await program()), { what: "the redone delete" });
  check("Redo removes it again", !/TEMP 50\.0,120/.test(await program()));
  await clickButton("↶ Undo");
  await waitFor(async () => (await program()) !== baseline, { what: "the first undo" });
  await clickButton("↶ Undo");
  await waitFor(async () => (await program()) === baseline, { what: "the session's first state" });
  check(
    "Undo walks all the way back to where this editing session started",
    (await program()) === baseline && baseline !== before,
    JSON.stringify({ now: await program(), baseline, before }),
  );

  // Ctrl-Y redoes from the keyboard, the same history the buttons walk.
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "y", code: "KeyY", windowsVirtualKeyCode: 89, modifiers: 2,
  });
  await waitFor(async () => (await program()) !== baseline, { what: "the keyboard redo" });
  check("Ctrl-Y redoes", (await program()) !== baseline, await program());

  // END is a row like any other to look at, and nothing at all to edit: no form, no delete.
  const endTools = await cdp.eval(`(() => {
    const l = [...document.querySelectorAll(".protoedit__line")]
      .find((x) => x.querySelector(".decoded__prototext").textContent.trim().startsWith("END"));
    return JSON.stringify({
      clickable: !!(l && l.querySelector(".protoedit__rowbtn:not(.is-inert)")),
      add: !!(l && l.querySelector(".protoedit__iconbtn:not(.protoedit__iconbtn--del)")),
      del: !!(l && l.querySelector(".protoedit__iconbtn--del")),
      last: l === [...document.querySelectorAll(".protoedit__line")].pop(),
    }); })()`).then(JSON.parse);
  check(
    "END can't be edited, deleted, or inserted at — and stays last",
    endTools.clickable === false && endTools.del === false && endTools.add === false && endTools.last === true,
    JSON.stringify(endTools),
  );
  // Every + straddles the boundary below its own group, so there is exactly one per gap: the last
  // step's is what appends past it (which is why END has none), and no two sit on the same gap.
  const insertSpots = await cdp.eval(`JSON.stringify([...document.querySelectorAll(".protoedit__line")]
    .map((g) => {
      const ins = g.querySelector(".protoedit__iconbtn--ins");
      if (!ins) return null;
      const box = g.querySelector(".protoedit__rowbtn").getBoundingClientRect();
      const b = ins.getBoundingClientRect();
      return Math.round(b.top + b.height / 2 - box.bottom);
    }).filter((v) => v !== null))`).then(JSON.parse);
  check(
    "every + sits on the boundary below its own group",
    insertSpots.length > 0 && insertSpots.every((d) => Math.abs(d) <= 3),
    JSON.stringify(insertSpots),
  );

  // A GOTO offers only the steps it may legally return to, described rather than numbered.
  await clickRow("GOTO");
  await waitFor(formOpen, { what: "the GOTO form" });
  const gotoTargets = await cdp.eval(`(() => {
    const line = [...document.querySelectorAll(".stepform__popover .stepform__line")]
      .find((l) => l.querySelector(".stepform__label").textContent.trim() === "Return to");
    return JSON.stringify([...line.querySelectorAll("option")].map((o) => o.textContent.trim())); })()`)
    .then(JSON.parse);
  check(
    "a GOTO may only target an earlier step, offered by what it returns to",
    gotoTargets.length > 0 &&
      gotoTargets.every((t) => /^Step \d+ — (TEMP|GRAD|MELT|PLATEREAD)/.test(t)) &&
      !gotoTargets.some((t) => /GOTO/.test(t)),
    JSON.stringify(gotoTargets),
  );
  // METHOD/HOTLID/VOLUME are three directives but one form, so they are one click target: one
  // highlight rather than three lit at once, and the form opens *below* all three rather than
  // through the middle of them.
  await closeForm();
  const headerBlock = await cdp
    .eval(`(() => {
      const group = document.querySelector(".protoedit__line");
      const texts = [...group.querySelectorAll(".decoded__prototext")].map((t) => t.textContent.trim());
      const btn = group.querySelector(".protoedit__rowbtn");
      if (btn) btn.click();
      return JSON.stringify({ targets: group.querySelectorAll(".protoedit__rowbtn").length, texts }); })()`)
    .then(JSON.parse);
  await waitFor(formOpen, { what: "the protocol settings form" });
  const headerGeom = await cdp
    .eval(`(() => {
      const b = document.querySelector(".protoedit__line .protoedit__rowbtn").getBoundingClientRect();
      const p = document.querySelector(".stepform__popover").getBoundingClientRect();
      const lit = document.querySelectorAll(".protoedit__line.is-open").length;
      const sel = [...document.querySelectorAll(".stepform__popover select")]
        .every((s) => s.getBoundingClientRect().right <= p.right);
      return JSON.stringify({ below: p.top >= b.bottom, lit, sel }); })()`)
    .then(JSON.parse);
  check(
    "the header's three directives are one click target, not three",
    headerBlock.targets === 1 &&
      headerBlock.texts.join(" ") === "METHOD CALC; HOTLID 105,30; VOLUME 20;" &&
      headerGeom.lit === 1,
    JSON.stringify({ ...headerBlock, lit: headerGeom.lit }),
  );
  check(
    "…and its form opens below all three, with no control spilling out of the popover",
    headerGeom.below && headerGeom.sel,
    JSON.stringify(headerGeom),
  );
  check(
    "the settings form edits the header, not a step",
    (await formLines()).map((l) => l.label).join(", ") ===
      "Method, Lid temperature, Lid off below, Sample volume",
    JSON.stringify((await formLines()).map((l) => l.label)),
  );

  // A modifier is a line of its own in the file but not a step: `BEEP` rides on the TEMP above it
  // (`protocol.md` §3.2), so the two are one group — one click target, one +/− pair, and a delete
  // that takes the modifier with the step rather than orphaning it.
  await closeForm();
  await clickRow("TEMP 95.0,60");
  await waitFor(formOpen, { what: "the TEMP form" });
  await cdp.eval(`(() => { const l = [...document.querySelectorAll(".stepform__line")]
     .find((x) => x.querySelector(".stepform__label").textContent.trim() === "Beep");
     const c = l && l.querySelector("input[type=checkbox]");
     if (c && !c.checked) c.click(); return !!c; })()`);
  await commitForm();
  await waitFor(async () => /BEEP/.test(await program()), { what: "the BEEP modifier" });
  const beeped = (await groups()).find((g) => g.lines.includes("BEEP;"));
  check(
    "a step and the modifier riding on it are one group, with one +/− pair",
    beeped?.lines.join(" ") === "TEMP 95.0,60; BEEP;" && beeped?.tools.join("") === "+−",
    JSON.stringify(beeped),
  );

  // Back to the GOTO's form, which the light-dismiss check below needs open with a dirty field.
  await closeForm();
  await clickRow("GOTO");
  await waitFor(formOpen, { what: "the GOTO form" });

  // Clicking away closes the form without applying it. That is the *browser's* light dismiss (the
  // form is a native `popover`), so it needs a real pointer press — a synthesized `click()` never
  // reaches the dismiss machinery, the same way a synthesized `mouseover` never opens a rail peek.
  const beforeDismiss = await program();
  await setField("Repeats", "7");
  const spot = await cdp
    .eval(`(() => { const r = document.querySelector(".overview__h").getBoundingClientRect();
       return JSON.stringify({ x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }); })()`)
    .then(JSON.parse);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: spot.x, y: spot.y, button: "left", buttons: 1, clickCount: 1,
    });
  }
  await waitFor(async () => !(await formOpen()), { what: "the form to light-dismiss" });
  check(
    "clicking elsewhere closes the form without applying it",
    (await program()) === beforeDismiss,
    await program(),
  );

  // The header block's + is the only way to get a step *before* step 1 — the whole reason it
  // carries one. It inserts at the top and renumbers everything after it, GOTO included.
  const beforeFirst = (await lines()).filter((l) => l.num);
  await rowTool("METHOD", ".protoedit__iconbtn--ins");
  await waitFor(formOpen, { what: "the new-first-step form" });
  const newFirstTitle = await cdp.eval(
    `(document.querySelector(".stepform__title") || {}).textContent || ""`,
  );
  await setField("Temperature", "42");
  await setField("Duration", "15");
  await commitForm();
  await waitFor(async () => /TEMP 42\.0,15;/.test(await program()), { what: "the new first step" });
  const withFirst = (await lines()).filter((l) => l.num);
  check(
    "the header block's + inserts a new step 1, renumbering the rest",
    newFirstTitle.trim() === "New step 1" &&
      withFirst[0]?.text === "TEMP 42.0,15;" &&
      withFirst[0]?.num === "1" &&
      withFirst[1]?.text === beforeFirst[0]?.text &&
      withFirst[1]?.num === "2",
    JSON.stringify({ title: newFirstTitle, was: beforeFirst.slice(0, 2), now: withFirst.slice(0, 2) }),
  );

  // Finally: a protocol this editor can't represent gets no editor at all. The Gradient fixture's
  // `GOTO 4,39` names a step that doesn't exist, so the builder refuses it — and says why.
  await loadFile(cdp, PRCL_TXT);
  await waitFor(() => chipPresent(cdp, "Gradient"), { what: "the unrepresentable .prcl.txt" });
  await clickTab(cdp, "Protocol");
  await tabBecomes(cdp, "Protocol");
  const refused = await editBtn();
  check(
    "a protocol the builder can't represent is refused an editor, with a reason",
    refused?.off === true && /can't be edited/.test(refused?.why ?? ""),
    JSON.stringify(refused),
  );
  cdp.close();
}


/**
 * The Overview toolbar's Clone button — a copy of the loaded file under the next free `(N)` name,
 * opened ready to be renamed (`App.tsx`'s `cloneActiveFile`, `lib/cloneName.ts`).
 *
 * Every step of it is silent-failure territory: the copy goes through `addFiles`, which *replaces*
 * a same-named file, so a naming bug doesn't error — it eats the original. And "opens it in edit
 * mode with the field focused" is state nothing else observes: a clone that lands correctly but
 * unfocused looks identical in a screenshot.
 *
 * Cloned twice on purpose, since the second clone is of a name that already carries an index —
 * the case that has to increment (`(3)`) rather than nest (`(2) (2)`).
 */
async function cloneChecks(chrome, origin) {
  console.log("\nclone");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");

  const state = () =>
    cdp
      .eval(
        `JSON.stringify((() => {
           const dts = [...document.querySelectorAll(".overview__infotable dt")];
           const dds = [...document.querySelectorAll(".overview__infotable dd")];
           const i = dts.findIndex((dt) => dt.textContent.trim() === "Filename");
           const input = document.querySelector(".overview__filename-input");
           return {
             // While the row is being edited it *is* the input, whose value is the name — the
             // <dd> around it has no text of its own.
             file: input ? input.value : i < 0 ? null : dds[i].textContent,
             editing: !!input,
             focused: !!input && document.activeElement === input,
             chips: [...document.querySelectorAll(".filechip__name")].map((c) => c.textContent),
           };
         })())`,
      )
      .then(JSON.parse);

  const base = EXAMPLE.replace(/\.zpcr$/, "");
  const clone = () => cdp.eval(`document.querySelector(".overview__clonebtn").click()`);

  await clone();
  await waitFor(async () => /\(2\)/.test((await state()).file ?? ""), { what: "the cloned file's Overview" });
  const first = await state();
  check(
    "Clone copies the file under a (2) name and opens the copy",
    first.file === `${base} (2).zpcr`,
    JSON.stringify(first),
  );
  check(
    "…in edit mode, with the filename field focused and ready to type over",
    first.editing && first.focused,
    JSON.stringify(first),
  );
  check(
    "…beside the original rather than replacing it",
    first.chips.length === 2 && first.chips.some((c) => c === "S183-S185 RVP"),
    JSON.stringify(first),
  );

  // Cloning the clone: the index increments rather than a second one being appended.
  await clone();
  await waitFor(async () => /\(3\)/.test((await state()).file ?? ""), { what: "the second clone" });
  const second = await state();
  check(
    "cloning a clone increments the index instead of nesting another one",
    second.file === `${base} (3).zpcr` && second.chips.length === 3,
    JSON.stringify(second),
  );

  // The copy is a real loaded file, not a view-level fiction: it has to still be there after a
  // reload, since nothing but IndexedDB holds it (it was never on disk).
  await cdp.eval(`document.querySelector(".overview__filename-input").blur()`);
  await sleep(300);
  await cdp.send("Page.navigate", { url: `${origin}#file=${encodeURIComponent(`${base} (3).zpcr`)}&view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(async () => (await state()).file !== null, { what: "the reloaded clone" });
  const reloaded = await state();
  check(
    "a clone survives a reload — it went into IndexedDB like any loaded file",
    reloaded.file === `${base} (3).zpcr` && reloaded.chips.length === 3,
    JSON.stringify(reloaded),
  );
  cdp.close();
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
    await headerFitChecks(chrome, origin);
    await routingChecks(chrome, origin, pw);
    await rightAxisChecks(chrome, origin);
    await tableSortChecks(chrome, origin);
    await persistedThresholdChecks(chrome, origin, pw);
    await cqFilterChecks(chrome, origin);
    await referenceChecks(chrome, origin);
    await calibrationChecks(chrome, origin);
    await passwordChecks(chrome, origin, pw);
    await xmlViewChecks(chrome, origin, pw);
    await alfViewChecks(chrome, origin);
    await thermalProfileChecks(chrome, origin);
    await instrumentRunChecks(chrome, origin);
    await runSeedChecks(chrome, origin);
    await incompleteRunChecks(chrome, origin);
    await experimentNameChecks(chrome, origin);
    await deleteConfirmChecks(chrome, origin);
    await protocolEditorChecks(chrome, origin);
    await cloneChecks(chrome, origin);
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
