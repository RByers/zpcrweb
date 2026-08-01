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
const PLTD = join(REPO, "samples/QuickPlate_96 wells_All Channels.pltd");
/** The Biomeme run export — the one input format that isn't Bio-Rad's, and the one that names
 * its own run rather than encoding the name in a filename. */
const BIOMEME = join(REPO, "samples/biomeme-2024-01-17.json");
/** The run whose `.pcrd` persists a hand-set FAM threshold — see {@link persistedThresholdChecks}. */
const RVP_PCRD = join(REPO, "samples/20260726_S183-S185_RVP.pcrd");
const EXAMPLE = "20260726_S183-S185_RVP.zpcr";
/** Written by {@link makeDupe}: the example under its own name but a different size. */
const DUPE = join(REPO, "tools/.uishot/dupe", EXAMPLE);
/** Fixtures for the Device view's `.prcl.txt` picker — written at test time rather than
 * committed, since the point is the text form this app writes, not a captured artifact. */
const PRCL_TXT = join(REPO, "tools/.uishot/dupe/Gradient.prcl.txt");
const BAD_TXT = join(REPO, "tools/.uishot/dupe/not-a-protocol.txt");
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
  await cdp.eval(`(() => { const b = [...document.querySelectorAll("button")]
      .find((b) => /^Delete .*RVP/.test(b.getAttribute("aria-label") || "")); b && b.click(); })()`);
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

/** True once a chip whose label matches `text` is in the file bar. */
const chipPresent = (cdp, text) =>
  cdp.eval(
    `[...document.querySelectorAll(".filechip__name")].some((n) => /${text}/.test(n.textContent))`,
  );

/**
 * The Device view's run staging: which loaded files make up the run that would be started.
 *
 * All of it is state a screenshot can't judge, and the selection rules are the substance —
 * one run at a time, a `.prcl.txt`/plate file overriding half of it, a run deselected once both
 * halves are overridden because it then contributes nothing (`state/useRunStaging.ts`). Getting
 * one of those wrong would silently stage a run out of the wrong files, which is the failure
 * mode that matters here. Also: that a `.prcl.txt` loaded through the app's ordinary load button
 * arrives as a chip and goes where it can be used, and that Start run appears only with an
 * instrument attached.
 */
async function deviceRunChecks(chrome, origin) {
  console.log("\ndevice run staging");
  const cdp = await openPage(chrome.base, origin);
  await sleep(600);
  // Earlier checks leave their own files in IndexedDB, so start from a known empty bar rather
  // than from whatever the suite happened to load last — the selection rules below are about
  // *which* chips are on, and a stray one makes every count meaningless.
  await emptyReload(cdp, origin);
  await loadFile(cdp, ZPCR);
  await sleep(800);
  await cdp.eval(
    `window.location.hash = "file=20260720_FirstQualification.zpcr&view=overview", undefined`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__blockhead")`), {
    what: "the overview protocol section",
  });

  // Overview is where a `.prcl.txt` comes from in the first place — the button is beside the
  // protocol section's heading, not the archive download at the top of the page.
  const dlLabel = await cdp.eval(
    `(document.querySelector(".overview__blockhead .raw__download") || {})
       .getAttribute?.("aria-label") ?? "missing"`,
  );
  check(
    "Overview offers the thermal protocol as a .prcl.txt download",
    /\.prcl\.txt/.test(dlLabel),
    dlLabel,
  );

  await cdp.eval(`window.location.hash = "view=device", undefined`);
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
          on: c.classList.contains("is-active"),
        })),
      };
    })()`);

  // The file bar is still the file bar — the Device view just reads it as a selection.
  const first = await staged();
  check(
    "the Device view keeps the app's file bar, in multi-select mode",
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

  // Start run belongs to the instrument, not the panel, so it is absent until one is attached.
  const startWhenIdle = await cdp.eval(`!!document.querySelector(".device__start")`);
  check("Start run appears only with an instrument connected", startWhenIdle === false);

  // A `.prcl.txt` goes in through the ordinary load button, not a picker of its own.
  mkdirSync(dirname(PRCL_TXT), { recursive: true });
  writeFileSync(PRCL_TXT, PRCL_TXT_BODY);
  await loadFile(cdp, PRCL_TXT);
  await waitFor(() => chipPresent(cdp, "Gradient"), { what: "the .prcl.txt chip" });
  await sleep(400);
  const loadedTab = await activeTab(cdp);
  check("loading a .prcl.txt lands on the Device view", loadedTab === "Device", loadedTab);

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

  // Tapping a selected file releases its slot — every slot, including the run's, so that
  // "no run at all" is reachable and a deselection isn't undone by a default.
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
  const noRun = await staged();
  check(
    "tapping the selected run deselects it too",
    !noRun.chips.find((c) => /FirstQualification/.test(c.name)).on,
    JSON.stringify(noRun.chips.filter((c) => c.on).map((c) => c.name)),
  );
  await tap("/FirstQualification/");
  await sleep(300);
  const rejoined = await staged();
  check(
    "a run rejoins a lone override rather than replacing it",
    rejoined.plate.override &&
      !rejoined.protocol.override &&
      /METHOD CALC/.test(rejoined.protocol.text),
    JSON.stringify({ plate: rejoined.plate.source, proto: rejoined.protocol.source }),
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
      on: [...document.querySelectorAll(".filebar--multi .filechip.is-active .filechip__name")]
        .map((n) => n.textContent.trim()),
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
async function experimentNameChecks(chrome, origin) {
  console.log("\nexperiment names");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");

  const headline = () =>
    cdp
      .eval(
        `JSON.stringify({
           name: document.querySelector(".overview__name")?.value ?? null,
           when: document.querySelector(".overview__when")?.textContent ?? null,
           file: document.querySelector(".overview__filename")?.textContent ?? null,
           chip: document.querySelector(".filechip__name")?.textContent ?? null,
           chipDate: document.querySelector(".filechip__date")?.textContent ?? null,
         })`,
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

  /**
   * Type into the name field and commit it. The two halves are separate turns on purpose: the
   * field commits on blur from the *committed* draft state, so blurring in the same tick as the
   * input event would read the value React hasn't applied yet — which real typing never does.
   */
  const setName = async (value) => {
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
  };

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

  // A Biomeme run names itself, and its Raw tab is the JSON document rather than an archive.
  await loadFile(cdp, BIOMEME);
  await waitFor(() => chipPresent(cdp, "2024-01-17-22220147"), { what: "the Biomeme chip" });
  check(
    "a Biomeme run uses the name the format itself carries",
    await chipPresent(cdp, "2024-01-17-22220147"),
  );
  await cdp.eval(`window.location.hash = "view=raw", undefined`);
  await tabBecomes(cdp, "Raw files");
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
    await routingChecks(chrome, origin, pw);
    await rightAxisChecks(chrome, origin);
    await tableSortChecks(chrome, origin);
    await persistedThresholdChecks(chrome, origin, pw);
    await cqFilterChecks(chrome, origin);
    await referenceChecks(chrome, origin);
    await calibrationChecks(chrome, origin);
    await passwordChecks(chrome, origin, pw);
    await xmlViewChecks(chrome, origin, pw);
    await deviceRunChecks(chrome, origin);
    await experimentNameChecks(chrome, origin);
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
