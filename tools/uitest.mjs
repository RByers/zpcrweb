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
  buildCore,
  cfxPassword,
  flushWrites,
  loadFile,
  navigateBlank,
  noteSoftTimeout,
  openPage,
  setFileInput,
  sleep,
  softTimeoutsSeen,
  startChrome,
  startDevServer,
  waitFor,
  waitStable,
  waitValue,
} from "./harness.mjs";

const ZPCR = join(REPO, "samples/20260720_FirstQualification.zpcr");
const PCRD = join(REPO, "samples/20260720_Luna_noRT.pcrd");
/** Three cycles and three plate reads — short enough that every read keeps its own number. */
const GRADIENT_ZPCR = join(REPO, "samples/20260725_GRADIENTTEST.zpcr");
const PLTD = join(REPO, "samples/QuickPlate_96 wells_All Channels.pltd");
/** The Biomeme run export — the one input format that isn't Bio-Rad's, and the one that names
 * its own run rather than encoding the name in a filename. */
const BIOMEME = join(REPO, "samples/biomeme-2024-01-17.bmrun");
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

/** A real run with its `ended` marker removed — byte for byte the shape of an archive the
 * instrument is still writing to, which is what the store keeps exploded (see
 * {@link explodedStorageChecks}). Built rather than committed, like {@link SHORT_ZPCR}. */
const IN_PROGRESS_ZPCR = join(REPO, "tools/.uishot/dupe/20260725-Still_Running.zpcr");

/** Write {@link IN_PROGRESS_ZPCR}: a finished sample, minus the marker that says it finished. */
async function makeInProgressRun() {
  const { zpcrFromRunFiles, unzipArchive, zipArchive } = await import("../packages/core/dist/index.js");
  const files = unzipArchive(
    new Uint8Array(readFileSync(join(REPO, "samples/20260725_GRADIENTTEST.zpcr"))),
  );
  delete files["ended"];
  const { archive } = zpcrFromRunFiles(files, { fileName: "20260725-Still_Running" });
  mkdirSync(dirname(IN_PROGRESS_ZPCR), { recursive: true });
  writeFileSync(IN_PROGRESS_ZPCR, Buffer.from(zipArchive(archive)));
}

/** Write {@link SHORT_ZPCR} by deleting plate reads from a committed sample's own files. */
async function makeShortRun() {
  const { zpcrFromRunFiles, unzipArchive, zipArchive } = await import("../packages/core/dist/index.js");
  const files = unzipArchive(
    new Uint8Array(readFileSync(join(REPO, "samples/20260725_GRADIENTTEST.zpcr"))),
  );
  const reads = Object.keys(files)
    .filter((n) => /\.Plateread$/i.test(n))
    .sort();
  for (const name of reads.slice(-2)) delete files[name];
  const { archive } = zpcrFromRunFiles(files, { fileName: "20260725-Cut_Short" });
  mkdirSync(dirname(SHORT_ZPCR), { recursive: true });
  writeFileSync(SHORT_ZPCR, Buffer.from(zipArchive(archive)));
}

/** A finished run that never read the plate — an incubation or reverse-transcription hold, whose
 * protocol carries no `PLATEREAD` and which therefore produces no `.Plateread` files at all.
 * Built rather than committed, like {@link SHORT_ZPCR}: this project has no such capture yet, and
 * what is being tested is the *absence* of readings, which any real run's files can stand in for
 * once they are taken out. */
const NO_READ_ZPCR = join(REPO, "tools/.uishot/dupe/20260725-RT_Incubation.zpcr");

/** Write {@link NO_READ_ZPCR}: a sample's own files, minus every plate read, with a protocol that
 * never asks for one — which is what makes it a run that finished exactly as written rather than
 * one that was cut short (`runCompleteness` declines to guess at a protocol with no PLATEREAD). */
async function makeNoReadRun() {
  const { zpcrFromRunFiles, unzipArchive, zipArchive } = await import("../packages/core/dist/index.js");
  const files = unzipArchive(
    new Uint8Array(readFileSync(join(REPO, "samples/20260725_GRADIENTTEST.zpcr"))),
  );
  const enc = new TextEncoder();
  for (const name of Object.keys(files)) {
    if (/\.Plateread$/i.test(name)) delete files[name];
    // The run report is the instrument's log of what it executed, and it lists every plate read
    // (`alf.md` §7.5) — so it has to be replaced along with the protocol, or the archive would
    // claim reads whose files aren't there.
    if (/\.alf$/i.test(name)) {
      files[name] = enc.encode(
        "\\Storage Card\\Recent\\RT_Incubation**RN050773*A*CFX96*Jul 25, 2026*21:18:16*21:31:05*" +
          "00:12:49*105.0*20.0**CT019138*CT019138*\n" +
          "METHOD CALC*HOTLID 105,30*VOLUME 20*TEMP 50.0,600*TEMP 95.0,120*END\n" +
          " No errors reported. *0:*False*False*False*False*None*False*\n" +
          "-1*1*1*.00*50.0*600*07/25/2026 21:18:24*False*0*\n" +
          "-1*1*2*.05*95.0*120*07/25/2026 21:28:30*False*0*\n",
      );
    }
  }
  files["ProtocolRunDefinition.txt"] = enc.encode(
    "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 50.0,600;TEMP 95.0,120;END;\n",
  );
  const { archive } = zpcrFromRunFiles(files, { fileName: "20260725-RT_Incubation" });
  mkdirSync(dirname(NO_READ_ZPCR), { recursive: true });
  writeFileSync(NO_READ_ZPCR, Buffer.from(zipArchive(archive)));
}

/**
 * A run with no plate reads in it opens, and only the views that need readings are withheld.
 *
 * The case the app used to have no answer for: a heat-block or RT run is a legitimate use of the
 * instrument, and its `.zpcr` is a complete record with no fluorescence in it. Everything that
 * doesn't need a reading — Overview, Protocol, Plates, Raw — has to work, Curves/Reference/
 * Calibration have to be greyed out rather than rendering an empty frame, and the run must not be
 * mistaken for one that stopped short or for a pending experiment.
 */
async function noPlateReadRunChecks(chrome, origin) {
  console.log("\na run that never reads the plate");
  await makeNoReadRun();
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, NO_READ_ZPCR);
  await waitFor(() => chipPresent(cdp, "RT Incubation"), { what: "the no-read run's chip" });

  const tabs = await cdp
    .eval(
      `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.viewbar [role="tab"]')]
         .map((b) => [b.textContent.trim(), !b.disabled])))`,
    )
    .then(JSON.parse);
  check(
    "the views that need readings are disabled, and the rest are not",
    tabs.Curves === false &&
      tabs.Reference === false &&
      tabs.Calibration === false &&
      tabs.Overview === true &&
      tabs.Protocol === true &&
      tabs.Plates === true &&
      tabs.Raw === true,
    JSON.stringify(tabs),
  );

  // It landed somewhere real rather than on a blank Curves view, and said nothing about a run
  // stopping short — a protocol that never reads cannot be short of reads.
  const landed = await activeTab(cdp);
  const accused = await cdp.eval(`document.querySelectorAll(".filechip__date--incomplete").length`);
  check("it opens on Overview, unaccused", landed === "Overview" && accused === 0, `${landed}, ${accused} flagged`);

  // The read-derived row is gone rather than reading "—", and the run's own facts are still there.
  const overview = await cdp.eval(
    `[...document.querySelectorAll(".overview__infotable dt")].map((e) => e.textContent.trim()).join("|")`,
  );
  check(
    "Overview drops the last-block-temp row and keeps the run's own facts",
    !overview.includes("Last block temp") && overview.includes("Cycles") && overview.includes("Block"),
    overview,
  );

  await clickTab(cdp, "Protocol");
  const protocolText = await cdp.eval(
    `(document.querySelector(".overview")?.textContent ?? "").replace(/\\s+/g, " ")`,
  );
  check(
    "Protocol renders the profile without pointing at plate reads that aren't drawn",
    protocolText.includes("TEMP 50.0,600") && !protocolText.includes("Plate reads"),
    protocolText.slice(0, 200),
  );
  cdp.close();
}

/**
 * A standalone Bio-Rad `.prcl` protocol opens as a file of its own — the encrypted form of the
 * same thing a `.prcl.txt` holds.
 *
 * The point of this block is the *container*: a `.prcl` is the ZipCrypto ZIP a `.pltd` is
 * (`zipcrypto.md`), so the file is unreadable until the password is supplied, and everything the
 * app shows for it has a locked state to get right first. That is the half a plain-text fixture
 * cannot exercise, and the half most likely to break — hence a locked page and an unlocked one,
 * against the same real sample.
 *
 * The rest is the rule the kind exists to state: it is a *protocol*, so it lands where a protocol
 * lands and offers the tabs a protocol offers, whichever encoding it arrived in. The one visible
 * difference from a `.prcl.txt` is that it cannot be edited — this project reads that container
 * but has no writer for it, the same standing a `.pltd` has against a `.plt.csv`.
 */
async function prclFileChecks(chrome, origin, pw) {
  console.log("\na standalone .prcl protocol");
  const PRCL = join(REPO, "samples/Qualification_Plate_96.prcl");

  // Locked first, from a page that has never been told the password. `emptyReload` twice around
  // the removal, as `passwordChecks` does: the key is read at startup, so clearing it has to be
  // followed by a reload for the app to come up without one.
  const locked = await openPage(chrome.base, origin);
  await emptyReload(locked, origin);
  await locked.eval(`localStorage.removeItem("zpcr:pltdPassword")`);
  await emptyReload(locked, origin);
  await loadFile(locked, PRCL);
  await waitFor(() => chipPresent(locked, "Qualification"), { what: "the locked .prcl chip" });
  // A protocol file opens on Overview whichever encoding it is in (the store's `addFiles`), so
  // the padlock on its chip is the whole of what a locked one says before you go looking.
  const lockedBadge = await waitValue(
    () =>
      locked.eval(
        `document.querySelector(".filebar .filechip.is-active .filechip__meta")?.textContent.trim() ?? ""`,
      ),
    (b) => b !== "",
    { what: "the locked .prcl's chip badge" },
  );
  check(
    "a locked .prcl wears the padlock a locked .pltd wears — same container, same answer",
    lockedBadge === "\u{1F512}",
    JSON.stringify(lockedBadge),
  );
  // And the prompt is on the tab the protocol would be on, which is where someone who clicked
  // through to read it arrives.
  await clickTab(locked, "Protocol");
  await tabBecomes(locked, "Protocol");
  const lockedShape = await locked
    .eval(
      `JSON.stringify({
         prompt: !!document.querySelector(".plate__pwform"),
         steps: document.querySelectorAll(".decoded__tbl tbody tr").length,
         listing: document.querySelectorAll(".decoded__protoline").length,
       })`,
    )
    .then(JSON.parse);
  check(
    "…and its Protocol tab asks for the password rather than showing an empty protocol",
    lockedShape.prompt && lockedShape.steps === 0 && lockedShape.listing === 0,
    JSON.stringify(lockedShape),
  );
  locked.close();

  // Unlocked, against the same file: the password goes in through the hash, as everywhere else.
  const cdp = await openPage(chrome.base, `${origin}#cfxPassword=${encodeURIComponent(pw)}`);
  await emptyReload(cdp, `${origin}#cfxPassword=${encodeURIComponent(pw)}`);
  await loadFile(cdp, PRCL);
  await waitFor(() => chipPresent(cdp, "Qualification"), { what: "the .prcl chip" });

  const tabs = await cdp
    .eval(
      `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.viewbar [role="tab"]')]
         .map((b) => [b.textContent.trim(), !b.disabled])))`,
    )
    .then(JSON.parse);
  check(
    "a .prcl enables exactly the tabs a .prcl.txt does — same thing, different encoding",
    tabs.Overview === true &&
      tabs.Protocol === true &&
      tabs.Raw === true &&
      tabs.Curves === false &&
      tabs.Plates === false &&
      tabs.Reference === false &&
      tabs.Calibration === false,
    JSON.stringify(tabs),
  );

  await clickTab(cdp, "Protocol");
  await tabBecomes(cdp, "Protocol");
  // The XML step list, not the directive listing: a `.prcl` carries a structured `protocol2`
  // exactly as a `.pcrd` does, and this is the same table that shows for one (`ProtocolView`
  // prefers real steps over the text they were rendered from).
  await waitFor(() => cdp.eval(`document.querySelectorAll(".decoded__tbl tbody tr").length > 0`), {
    what: "the decrypted .prcl's step table",
  });
  const listing = await cdp
    .eval(
      `JSON.stringify({
         rows: [...document.querySelectorAll(".decoded__tbl tbody tr")]
           .map((r) => r.textContent.replace(/\\s+/g, " ").trim()),
         edit: [...document.querySelectorAll("button")]
           .some((b) => /^Edit this protocol$/.test(b.getAttribute("aria-label") ?? "")),
       })`,
    )
    .then(JSON.parse);
  check(
    "…and decrypts into the protocol it holds, step by step",
    listing.rows.length === 5 &&
      listing.rows.some((r) => /98/.test(r)) &&
      listing.rows.some((r) => /Return to step/.test(r)),
    JSON.stringify(listing.rows),
  );
  check(
    "a .prcl gets no editor, having no writer to save an edit through",
    listing.edit === false,
    JSON.stringify({ edit: listing.edit }),
  );

  // Raw shows the decrypted payload, which is XML — the same tree the standalone `.pltd` gets,
  // and for the same reason: the container is the same one.
  await clickTab(cdp, "Raw");
  await tabBecomes(cdp, "Raw");
  await waitFor(() => cdp.eval(`!!document.querySelector(".decoded__xml, .raw__dump")`), {
    what: "the .prcl's raw payload",
  });
  const raw = await cdp
    .eval(
      `JSON.stringify({
         label: [...document.querySelectorAll(".raw__modes .segmented__item")]
           .map((b) => b.textContent.trim()),
         tree: !!document.querySelector(".decoded__xml"),
         dump: !!document.querySelector(".raw__dump"),
         text: (document.querySelector(".decoded__xml")?.textContent ?? "").slice(0, 200),
       })`,
    )
    .then(JSON.parse);
  check(
    "a .prcl's Raw tab decrypts to its XML payload, rendered as the XML tree",
    raw.label.includes("XML") && raw.tree && !raw.dump && /protocol2/.test(raw.text),
    JSON.stringify({ label: raw.label, tree: raw.tree, head: raw.text.slice(0, 80) }),
  );
  cdp.close();
}

/**
 * A standalone `.alf` run report opens as a file of its own.
 *
 * This is what a thermal-only run produces instead of a `.zpcr` — the instrument writes no run
 * folder for a protocol with no `PLATEREAD` (`usb.md` §7.10), so the app collects the report and
 * puts it in the bar. The sample is a real one, off the instrument: a 2:36 `METHOD BLOCK` hold.
 *
 * Three things have to hold. It has to be *admitted* at all, which is a file-kind question and the
 * one this used to fail on. Only Overview, Protocol and Raw may be enabled — a report has no
 * curves and no plate, and every other tab rendering an empty frame is the failure this app greys
 * tabs out to avoid. And the report has to land on the three tabs at their three altitudes:
 * Overview summarises it, Protocol draws what ran and what it cost, Raw holds the file whole.
 */
async function reportFileChecks(chrome, origin) {
  console.log("\na standalone .alf run report");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples/20260807_231326_CT019138_AGBLK1.alf"));
  // The chip shows the file bar's tidied name ("CT019138 AGBLK1"), not the file's own.
  await waitFor(() => chipPresent(cdp, "AGBLK1"), { what: "the report's chip" });

  const tabs = await cdp
    .eval(
      `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.viewbar [role="tab"]')]
         .map((b) => [b.textContent.trim(), !b.disabled])))`,
    )
    .then(JSON.parse);
  check(
    "Overview, Protocol and Raw are enabled — a report has nothing for the other tabs",
    tabs.Overview === true &&
      tabs.Protocol === true &&
      tabs.Raw === true &&
      tabs.Curves === false &&
      tabs.Plates === false &&
      tabs.Reference === false &&
      tabs.Calibration === false,
    JSON.stringify(tabs),
  );

  const landed = await activeTab(cdp);
  check("it opens on Overview", landed === "Overview", landed);

  const overview = await cdp.eval(
    `(document.querySelector(".overview")?.textContent ?? "").replace(/\\s+/g, " ")`,
  );
  check(
    "the identity card names it as a report and states the run, time and outcome",
    overview.includes("Report:") &&
      overview.includes("AGBLK1") &&
      overview.includes("00:02:36") &&
      overview.includes("No errors reported"),
    overview.slice(0, 220),
  );
  check(
    // An Overview is the prettified view: it counts what the log holds and stops there. The log
    // itself, the header's every field and the protocol are the Raw tab's Decoded mode, which is
    // the view whose rule is "everything the file has".
    "…and counts what ran, without becoming a second copy of the file",
    overview.includes("Executed") &&
      !overview.includes("Execution log") &&
      !overview.includes("Lid pressure") &&
      !overview.includes("HOTLID"),
    overview.slice(0, 400),
  );

  // What ran and what it cost is the Protocol tab's, for a report exactly as for a run: the
  // report's own copy of the protocol (post-expansion, `alf.md` §5) as the annotated listing, and
  // its step log as the thermal profile. This is the tab a report never used to have.
  await clickTab(cdp, "Protocol");
  await waitFor(() => cdp.eval(`!!document.querySelector(".thermal canvas")`), {
    what: "the report's thermal profile chart",
  });
  const protocol = await cdp
    .eval(
      `JSON.stringify({
         text: (document.querySelector(".overview")?.textContent ?? "").replace(/\\s+/g, " "),
         chart: !!document.querySelector(".thermal canvas"),
       })`,
    )
    .then(JSON.parse);
  check(
    "Protocol shows the protocol the report says ran, marked as executed rather than authored",
    protocol.text.includes("Thermal protocol as executed") &&
      protocol.text.includes("TEMP 37.0,30"),
    protocol.text.slice(0, 300),
  );
  check(
    "…and the step log as the thermal profile — the shape of the run, not its every line",
    protocol.text.includes("Thermal profile as run") && protocol.chart,
    JSON.stringify(protocol.chart),
  );

  // Raw is where the file is shown whole. A standalone report gets the same Decoded mode an
  // in-archive one does, and opens on it — its own text being a `*`-delimited wall of numbers is
  // exactly why a Text-only raw view would be the app's weakest reading of a file it owns.
  await clickTab(cdp, "Raw");
  await waitFor(() => cdp.eval(`!!document.querySelector('.raw__decoded .decoded__alf')`), {
    what: "the standalone report's decoded execution log",
  });
  const decoded = await cdp
    .eval(
      `JSON.stringify({
         mode: document.querySelector('.raw__modes .segmented__item.is-active')?.textContent.trim(),
         text: (document.querySelector('.raw__decoded')?.textContent ?? "").replace(/\\s+/g, " "),
         rows: document.querySelectorAll('.raw__decoded .decoded__alf tbody tr').length,
       })`,
    )
    .then(JSON.parse);
  check(
    "a standalone report's Raw tab opens on Decoded, holding the whole file",
    decoded.mode === "Decoded" &&
      decoded.text.includes("Lid pressure") &&
      decoded.text.includes("HOTLID") &&
      decoded.text.includes("User aborted") &&
      decoded.rows === 2,
    `${decoded.mode}, ${decoded.rows} log rows`,
  );

  await cdp.eval(
    `[...document.querySelectorAll('.raw__modes .segmented__item')]
       .find(b => b.textContent.trim() === 'Text').click()`,
  );
  const raw = await cdp.eval(
    `(document.querySelector(".raw__dump")?.textContent ?? "").slice(0, 120)`,
  );
  check("…and its Text mode still shows the report's own bytes", raw.includes("AGBLK1*admin*"), raw);
  cdp.close();
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
  const {
    buildExperimentArchive,
    markExperimentBegun,
    writeZpcrwebSettings,
    zipArchive,
    plateToCsv,
    parsePlateCsv,
  } = await import("../packages/core/dist/index.js");
  const runDefinition =
    "METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,39;END;";
  const plate = parsePlateCsv(PLATE_CSV_BODY, { sourceName: "Staged.plt.csv" });
  // The three steps the app itself takes, in the same order: build the experiment, name it, and
  // mark it begun. What comes out is a run that has started and produced nothing yet — the state
  // the old seed archive represented, now reached by starting a file that already existed. Each
  // step hands the next an archive, so the whole chain costs the one `zipArchive` at the end.
  const started = markExperimentBegun(
    writeZpcrwebSettings(
      buildExperimentArchive({
        protocol: { runDefinition, name: "Cycling" },
        plate: { name: "Staged.plt.csv", bytes: new TextEncoder().encode(plateToCsv(plate)) },
      }),
      { experimentName: "Seeded Run" },
    ),
  );
  mkdirSync(dirname(SEED_ZPCR), { recursive: true });
  writeFileSync(SEED_ZPCR, Buffer.from(zipArchive(started)));
}

/**
 * A same-name, *different-size* copy of the example. A file is keyed by its name alone, so the
 * replace rule fires for a byte-identical reload too — this copy differs in size so the check can
 * tell the replacement apart from the original by what the Files table reports. Four trailing zero
 * bytes: a ZIP reader finds the end-of-central-directory by scanning backwards, so it still parses.
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
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
}

/**
 * Every file name the IndexedDB catalog currently holds.
 *
 * The record-level truth behind the file bar, and the observable for the writes that have no
 * on-screen signal at all: closing a file (its record is deleted) and renaming one (`renameFile`
 * rehashes the id, so the record is rewritten under a new key). Both used to be `sleep(300)` on
 * the grounds that nothing visible changes — nothing visible does, but the store is readable.
 */
const catalogNames = (cdp) =>
  cdp
    .eval(
      `new Promise((res) => { const q = indexedDB.open("zpcrweb");
         q.onsuccess = () => { const db = q.result;
           const g = db.transaction("catalog", "readonly").objectStore("catalog").getAll();
           g.onsuccess = () => { res(JSON.stringify(g.result.map((r) => r.name ?? ""))); db.close(); }; };
         q.onerror = () => res("[]"); })`,
      { awaitPromise: true },
    )
    .then(JSON.parse);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  → ${detail}` : ""}`);
}

/**
 * Wait for the active tab to read `label`, returning whatever it actually settled on.
 *
 * Reporting rather than insisting is deliberate — a few callers assert on where the view *did*
 * land. But most ignore the return value, and for those a timeout used to be both silent and 8 s
 * long, so it is recorded as a soft timeout and fails the run at the end.
 */
async function tabBecomes(cdp, label, timeout = 8000) {
  let seen = "none";
  const started = Date.now();
  try {
    await waitFor(async () => (seen = await activeTab(cdp)) === label, { timeout, what: label });
  } catch {
    noteSoftTimeout(`the ${label} tab to become active`, seen, Date.now() - started);
  }
  return seen;
}

/** Click a `.viewbar` tab by its visible label — the Files/Instrument tabs (their own
 * `.segmented--*` groups, `ViewBar.tsx`) as well as the main strip's. Scoped to `.viewbar`
 * rather than every `[role="tab"]` in the page, since a file chip is one too. */
/**
 * Click a plain `<button>` found by its exact label, waiting for it to exist first.
 *
 * The idiom this replaces — `[...querySelectorAll("button")].find(...); b && b.click()` — is a
 * silent no-op when the button hasn't rendered yet, and the caller then waits out its own
 * timeout on a control it never actually pressed. Failing here instead names the button.
 */
const clickButton = async (cdp, label) => {
  const sel = `[...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  await waitFor(() => cdp.eval(`!!(${sel})`), { what: `the ${label} button` });
  await cdp.eval(`(() => { (${sel}).click(); })()`);
};

/**
 * Click a labelled button until `settled()` holds, re-clicking between polls.
 *
 * For controls whose state the app also writes itself: the Curves view mode is seeded from the
 * file's stored settings in an effect that runs after hydration, so a click that lands in the
 * window before it gets overwritten and the mode silently snaps back. One click plus a wait then
 * times out on a view that was asked for and then taken away. Re-clicking rides that out without
 * hiding a real failure — if the view never appears, this still throws.
 */
const clickUntil = async (cdp, label, settled, what) => {
  const deadline = Date.now() + 15000;
  for (;;) {
    await clickButton(cdp, label);
    if (await waitValue(settled, (v) => !!v, { timeout: 1500 })) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
};

/**
 * Click a view tab and wait for it to take the selection.
 *
 * This used to tolerate the tab never activating, on the grounds that a few callers click one
 * precisely to show it is disabled. No caller does — they read the tab's `disabled` state instead
 * — so the tolerance only bought 2 s of silence whenever a click genuinely failed to land.
 */
const clickTab = async (cdp, label) => {
  const sel = `[...document.querySelectorAll('.viewbar [role="tab"]')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
  // `document.readyState === "complete"` is true well before React has drawn the view bar, so a
  // bare `t?.click()` here was a silent no-op whenever this ran early — the caller then waited
  // out its own timeout on a view that had never been asked for. Wait for the tab to exist.
  await waitFor(() => cdp.eval(`!!(${sel})`), { what: `the ${label} tab` });
  await cdp.eval(`(() => { (${sel}).click(); })()`);
  await waitValue(
    () => cdp.eval(`(${sel})?.getAttribute("aria-selected") === "true"`),
    (v) => v === true,
    { timeout: 2000, what: `the ${label} tab to take the selection` },
  );
};

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
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  await cdp.eval(`window.location.hash = "view=calibration", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".calgroup")`), { what: "calibration rail" });

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

  // Both plate-type groups have to be on screen before the chips are counted — the `waitFor`
  // above only gates on the first one existing.
  await waitValue(
    () => cdp.eval(`document.querySelectorAll(".calgroup").length`),
    (n) => n >= 2,
  );
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
  // Wait for the selection to *change*, then assert what it changed to.
  const afterOn = (
    await waitValue(chips, (cs) => cs.filter((c) => c.on).length !== on.length)
  ).filter((c) => c.on);
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
  const absoluteCurves = await waitValue(curveCount, (n) => n !== relativeCurves);
  await clickToggle("Relative");
  const backToRelative = await waitValue(curveCount, (n) => n !== absoluteCurves);
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

  // The hash is written after the file lands, so wait for it to carry anything at all before
  // asking what it carries.
  const h1 = await waitValue(() => cdp.eval("window.location.hash"), (h) => /file=/.test(h));
  check("hash carries file+view once a file is active", /file=/.test(h1) && /view=/.test(h1), h1);
  check(
    "file param round-trips the real name",
    new URLSearchParams(h1.replace(/^#/, "")).get("file") === "20260720_FirstQualification.zpcr",
  );

  // Clicking a tab must write the hash — this is what makes any view linkable.
  await clickTab(cdp, "Plates");
  // Stable, not merely changed: the app can write the hash more than once settling into a view,
  // and `back()` below has to leave from the entry it finishes on rather than an intermediate
  // one — which is exactly how "back() restores the previous view" failed intermittently.
  const clicked = await waitStable(() => cdp.eval("window.location.hash"));
  check("clicking a tab writes view= to the hash", /view=plates/.test(clicked), clicked);

  // pushState (not replaceState) on user-driven changes is what makes these two work.
  await cdp.eval("window.history.back()");
  const back = await tabBecomes(cdp, "Curves");
  check("back() restores the previous view", back === "Curves", `tab "${back}"`);
  await cdp.eval("window.history.forward()");
  const fwd = await tabBecomes(cdp, "Plates");
  check("forward() re-applies the view", fwd === "Plates", `tab "${fwd}"`);

  /**
   * Navigate to `url` and wait until the app is actually up.
   *
   * `document.readyState === "complete"` only says the document parsed; the app then hydrates
   * from IndexedDB, which for a 400 KB archive is parse plus analysis. Starting `tabBecomes`'
   * own 8 s clock at readyState puts hydration inside it, and on a loaded machine that is how
   * "cold deep link opens the named view" failed while the app was doing nothing wrong.
   */
  const coldLoad = async (url) => {
    await cdp.send("Page.navigate", { url });
    await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
    await waitFor(() => cdp.eval(`!!document.querySelector('.viewbar [role="tab"]')`), {
      what: `the app to come up on ${url.replace(/^.*#/, "#")}`,
    });
    // The view bar is drawn before the named file has been hydrated, and a view like Reference
    // cannot become active until it has. Waiting for the chip too puts the parse *outside*
    // `tabBecomes`' 8 s clock rather than inside it — which is what made the Reference deep link
    // fail on a loaded machine while the app was doing nothing wrong. Only for a URL that names a
    // file the browser actually has: `#file=nope.zpcr` deliberately names one it doesn't.
    const named = /[#&]file=([^&]+)/.exec(url)?.[1];
    if (named && !/nope/.test(named)) {
      await waitFor(() => cdp.eval(`!!document.querySelector(".filechip")`), {
        what: `the deep-linked file's chip on ${url.replace(/^.*#/, "#")}`,
      });
    }
  };

  // A cold load must honor the hash without flashing the default view first.
  await coldLoad(`${origin}#file=20260720_FirstQualification.zpcr&view=reference`);
  const cold = await tabBecomes(cdp, "Reference");
  check("cold deep link opens the named view", cold === "Reference", `tab "${cold}"`);

  // The Files table is not a lens on the active file, but it is linkable like any other view.
  await coldLoad(`${origin}#file=20260720_FirstQualification.zpcr&view=files`);
  const filesTab = await tabBecomes(cdp, "Files");
  check("cold deep link opens the Files table", filesTab === "Files", `tab "${filesTab}"`);
  check(
    "the Files view stays in the hash",
    /view=files/.test(await cdp.eval("window.location.hash")),
    await cdp.eval("window.location.hash"),
  );

  // Files live in IndexedDB and can't be fetched from a link, so an unknown name must degrade.
  await coldLoad(`${origin}#file=nope.zpcr&view=plates`);
  const unknown = await tabBecomes(cdp, "Plates");
  check("unknown file falls back but keeps the view", unknown === "Plates", `tab "${unknown}"`);

  await coldLoad(`${origin}#view=notaview`);
  const junk = await waitValue(() => activeTab(cdp), (t) => t !== "none");
  check("invalid view value falls back to a real tab", junk !== "none", `tab "${junk}"`);

  // ── `#wells=`, a selection in a link ───────────────────────────────────────────────────
  // The well grid is the observable: `is-on` is exactly the enabled set, so the labels say
  // which wells a selector actually reached.
  const wellsOn = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll(".wm-cell.is-on")]
           .map((e) => (e.getAttribute("aria-label") || "").replace(/^Well /, "").split(" — ")[0])
           .sort())`,
      )
      .then(JSON.parse);

  const FILE = "20260720_FirstQualification.zpcr";
  await coldLoad(`${origin}#file=${FILE}&view=curves&wells=A1,C4-E6`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".wm-cell")`), { what: "the well grid" });
  // 1 + a 3×3 rectangle: the range is the block its corners bound, not reading order.
  const linked = await waitValue(() => wellsOn(), (w) => w.length === 10, {
    what: "the linked wells to be the only ones enabled",
  });
  check(
    "a #wells= link enables exactly the wells it names",
    linked.join(",") === "A1,C4,C5,C6,D4,D5,D6,E4,E5,E6",
    linked.join(","),
  );
  const wellsHash = await waitStable(() => cdp.eval("window.location.hash"), {
    what: "the hash after a #wells= link",
  });
  check("#wells= is consumed rather than left in the hash", !/wells=/.test(wellsHash), wellsHash);

  // It went in as ordinary display state, so it is in IndexedDB and survives a real reload —
  // the record, not the screen, is what proves that (the 300 ms settings write has no on-screen
  // signal of its own).
  const storedWells = await waitValue(
    () =>
      cdp
        .eval(
          `new Promise((res) => { const q = indexedDB.open("zpcrweb");
             q.onsuccess = () => { const db = q.result;
               const g = db.transaction("catalog", "readonly").objectStore("catalog").get(${JSON.stringify(FILE)});
               g.onsuccess = () => { res((g.result?.view?.enabledWells ?? []).length); db.close(); }; };
             q.onerror = () => res(-1); })`,
          { awaitPromise: true },
        ),
    (n) => n === 10,
    { what: "the linked selection to reach IndexedDB" },
  );
  check("a linked selection is persisted like a hand-made one", storedWells === 10, `${storedWells}`);
  await navigateBlank(cdp);
  await coldLoad(`${origin}#file=${FILE}&view=curves`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".wm-cell")`), { what: "the well grid" });
  const reloaded = await waitValue(() => wellsOn(), (w) => w.length === 10, {
    what: "the persisted selection after a reload",
  });
  check("the selection survives a reload without the key", reloaded.length === 10, `${reloaded.length} wells`);

  // A later link replaces the selection rather than adding to it.
  await cdp.eval(`window.location.hash = "file=${FILE}&view=curves&wells=B2", undefined`);
  const relinked = await waitValue(() => wellsOn(), (w) => w.length === 1, {
    what: "a second #wells= link to replace the selection",
  });
  check("a later link replaces the selection", relinked.join(",") === "B2", relinked.join(","));

  // Negative: a selector naming no real well is ignored outright, so the selection stands. There
  // is no state change to wait for — hence a sleep, the one thing it is for.
  await cdp.eval(`window.location.hash = "file=${FILE}&view=curves&wells=Q13", undefined`);
  await sleep(500);
  const afterJunk = await wellsOn();
  check(
    "a selector matching no well leaves the selection alone",
    afterJunk.join(",") === "B2",
    afterJunk.join(","),
  );

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
  // `document.readyState === "complete"` is true before React has rendered anything, so the
  // welcome screen's buttons have to be waited for rather than assumed. A fixed sleep here used
  // to fail the whole run, intermittently, as `undefined is not a function` on the click below.
  const welcomeBtn = (re) =>
    cdp.eval(
      `!![...document.querySelectorAll("button")].find((b) => ${re}.test(b.textContent))`,
    );
  await waitFor(() => welcomeBtn("/Connect an instrument/i"), { what: "the welcome screen" });

  // 0. The other thing the welcome screen offers: an instrument, with nothing loaded and nothing
  //    created. The Instrument tab is not a lens on a file (see `ViewBar`), so it is reachable
  //    from an empty browser — this used to have to invent an experiment first just to have a
  //    file for the tab to hang off. What has to be true afterwards is that the real view is up,
  //    the strip is there with Instrument live, and the catalog is still empty.
  await cdp.eval(
    `(() => { [...document.querySelectorAll("button")]
        .find((b) => /Connect an instrument/i.test(b.textContent)).click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".instrument__rail")`), {
    what: "the Instrument view from an empty browser",
  });
  const fromEmpty = await cdp.eval(`(() => ({
    chips: document.querySelectorAll(".filebar .filechip").length,
    live: [...document.querySelectorAll('.viewbar [role="tab"]')]
      .filter((b) => !b.disabled).map((b) => b.textContent.trim()),
    connect: !![...document.querySelectorAll("button")]
      .find((b) => /Connect over USB/i.test(b.textContent)),
    says: document.querySelector(".instrument__empty")?.textContent.trim() || "",
  }))()`);
  check(
    "the welcome screen's instrument button opens the view itself, creating no file",
    fromEmpty.chips === 0 &&
      fromEmpty.connect &&
      fromEmpty.live.join(",") === "Files,Instrument" &&
      /No experiment selected/.test(fromEmpty.says),
    JSON.stringify(fromEmpty),
  );
  // Back to the welcome screen for the example-link checks below — the view is sticky, and this
  // browser is still empty.
  await emptyReload(cdp, origin);
  await waitFor(
    () => cdp.eval(`!![...document.querySelectorAll("a")].find(x => /load an example/i.test(x.textContent || ""))`),
    { what: "the welcome screen's example link" },
  );

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
  // The example is one of the bundled samples, so it is filed under the samples folder however it
  // was asked for — including through this link, which is a plain `#load=<url>` (`sampleNameFromUrl`).
  check(
    "example link loads the served sample, filed under the samples folder",
    /file=samples(%2F|\/)20260726_S183-S185_RVP\.zpcr/.test(exampleHash),
    exampleHash,
  );
  check("the load= instruction is consumed, not left in the hash", !/load=/.test(exampleHash));

  // 2. A dropped file whose name matches a *sample*'s bare name is a different file, and both
  //    stay: the sample is `samples/<name>`, which is the point of the prefix.
  await loadFile(cdp, DUPE);
  const chipTitles = () =>
    cdp
      .eval(`JSON.stringify([...document.querySelectorAll(".filechip")].map((c) => c.title || c.textContent.trim()))`)
      .then(JSON.parse);
  const withDupe = await waitValue(chipTitles, (t) => t.length !== 1);
  check(
    "a dropped file doesn't displace a sample that shares its bare name",
    withDupe.length === 2,
    JSON.stringify(withDupe),
  );

  // 3. …and same-name replacement itself still holds: dropping it again replaces it rather than
  //    adding an indistinguishable second chip.
  // A *negative* assertion — that no third chip appears — so this one has to be elapsed time
  // rather than a wait on a condition. `loadFile`'s own wait is satisfied the moment it starts,
  // the view tabs being already on screen from the load above.
  await loadFile(cdp, DUPE);
  await sleep(800);
  const chips = await cdp.eval(`document.querySelectorAll(".filechip").length`);
  check("re-loading a name replaces the file instead of duplicating it", chips === 2, `${chips} chips`);

  // 4. A cold deep link does the fetch on its own, with nothing in IndexedDB to fall back on.
  await emptyReload(cdp, `${origin}#load=examples/20260726_S183-S185_RVP.zpcr&view=plates`);
  await waitFor(() => cdp.eval(`document.querySelectorAll(".filechip").length === 1`), {
    what: "deep-linked file",
  });
  const cold = await tabBecomes(cdp, "Plates");
  check("cold #load= link fetches the file and honors view=", cold === "Plates", `tab "${cold}"`);

  // 5. A bad URL surfaces an error rather than hanging on the welcome screen.
  await emptyReload(cdp, `${origin}#load=examples/nope.zpcr`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".app__error")`), {
    what: "the 404's error banner",
  });
  const errored = await cdp.eval(`!!document.querySelector(".app__error")`);
  const stillWelcome = await cdp.eval(`!!document.querySelector(".app--empty")`);
  check("a #load= that 404s reports an error and keeps the welcome screen", errored && stillWelcome);

  // 6. …and the banner can be got rid of. It floats over the bottom-right corner of the page, so
  // an error with no ✕ covers whatever is under it — including, for a folder whose permission has
  // lapsed, the "Grant access" button that would fix it — for the rest of the session.
  await cdp.eval(`document.querySelector(".app__errordismiss").click()`);
  check(
    "…and the error banner's ✕ dismisses it",
    !(await waitValue(() => cdp.eval(`!!document.querySelector(".app__error")`), (v) => !v)),
  );

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
  // The header's `data-fit` is written by a ResizeObserver callback, so it lands a frame or two
  // after the header itself mounts.
  await waitFor(() => cdp.eval(`!!document.querySelector(".app__header")?.dataset.fit`), {
    what: "the header's measured fit",
  });

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
  const wide = await waitValue(
    () => cdp.eval(`document.querySelector(".app__header").dataset.fit`),
    (f) => f !== narrow.fit,
  );
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
  const leds = (await waitValue(() => chips("LED current"), (c) => c?.some((x) => x.on))) ?? [];
  check(
    "every channel's LED drive current is plotted, previewed in DAC counts",
    leds.length === 6 && leds.every((c) => c.on) && /^\d+ DAC$/.test(leds[0].value),
    leds.map((c) => `${c.label} ${c.value}`).join(", "),
  );

  // Enabling temperatures must take the axis over, not share it.
  check("temperatures get their own rail section", (await clickAll("Temperature")) === "ok");
  const temps = (await waitValue(() => chips("Temperature"), (c) => c?.some((x) => x.on))) ?? [];
  const ledsAfter = (await chips("LED current")) ?? [];
  check(
    "enabling temperatures clears the LED currents — one right axis, one unit",
    temps.some((c) => c.on) && ledsAfter.every((c) => !c.on),
    `${temps.filter((c) => c.on).length} temps on, ${ledsAfter.filter((c) => c.on).length} LEDs on`,
  );

  // And back the other way, so neither direction is the special case.
  await clickAll("LED current");
  await waitValue(() => chips("LED current"), (c) => c?.every((x) => x.on));
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
  // Closing a file is what takes it out of IndexedDB, and either ✕ does it — this uses the Files
  // table's, since ZPCR (the shared fixture, kept open across checks) is in there too by this point
  // and the RVP row has to be picked out by name rather than by grabbing the first chip. One click:
  // the file is unedited, so nothing is at risk and nothing arms.
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector(".filesview__row")`), { what: "the files table" });
  await cdp.eval(`(() => { const row = [...document.querySelectorAll(".filesview__row")]
      .find((r) => /RVP/.test(r.textContent));
      row?.querySelector(".ftbl__del")?.click(); })()`);
  await waitFor(
    () => cdp.eval(`![...document.querySelectorAll(".filesview__row")].some((r) => /RVP/.test(r.textContent))`),
    { what: "the RVP .pcrd to close" },
  );
  await cdp.eval(`(() => { document.querySelector(".filesview__close")?.click(); })()`);
  // The delete transaction committing is the thing to wait for, and while nothing left on screen
  // shows it, the catalog itself does — so read that rather than time an interval and hope. (It
  // used to be a `sleep(300)` on the grounds that there was no observable; the store is one.)
  await waitFor(async () => !(await catalogNames(cdp)).some((n) => /RVP/.test(n)), {
    what: "the RVP .pcrd's catalog record to be deleted",
  });
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
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  check(
    "the Curves rail offers Table mode",
    (await cdp.eval(
      `!![...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Table")`,
    )) === true,
  );
  await clickUntil(
    cdp,
    "Table",
    () => cdp.eval(`!!document.querySelector(".atbl")`),
    "the analysis table",
  );

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
  const wellAsc = await waitValue(
    () => column("Well"),
    (c) => JSON.stringify(c) !== JSON.stringify(wellsBefore),
  );
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
  const wellDesc = await waitValue(
    () => column("Well"),
    (c) => JSON.stringify(c) !== JSON.stringify(wellAsc),
  );
  check(
    "clicking the same header again reverses it",
    JSON.stringify(wellDesc) === JSON.stringify([...wellAsc].reverse()),
    (wellDesc ?? []).join(" "),
  );

  await clickHead("Cq");
  await waitValue(sortedHeads, (h) => JSON.stringify(h) === '["Cq"]');
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
  const cqDesc = await waitValue(
    () => column("Cq"),
    (c) => JSON.stringify(c) !== JSON.stringify(cqAsc),
  );
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
  await waitValue(sortedHeads, (h) => JSON.stringify(h) === '["End RFU"]');
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
 * Table mode's Well/Sample/Target pickers: clicking one of those three values leaves the table
 * for the Target view charting just that well, sample or target. What's checked is the *state*
 * each click leaves behind — which mode is active and which rail chips survive — since a chart
 * with fewer curves on it looks the same however the curves were chosen.
 */
async function tablePickChecks(chrome, origin) {
  console.log("\ncurves table mode (well/sample/target pickers)");
  const cdp = await openPage(chrome.base, origin);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });

  const toTable = () =>
    clickUntil(
      cdp,
      "Table",
      () => cdp.eval(`!!document.querySelector(".atbl")`),
      "the analysis table",
    );
  /** The first row's three picker buttons, in column order: Well, Sample, Target. */
  const pickers = () =>
    cdp.eval(`[...document.querySelector(".atbl tbody tr").querySelectorAll(".atbl__pick")]
        .map((b) => b.textContent.trim())`);
  const clickPicker = async (i) => {
    await cdp.eval(
      `(() => { document.querySelector(".atbl tbody tr").querySelectorAll(".atbl__pick")[${i}].click(); })()`,
    );
    // The pick leaves table mode for a chart; that swap is the observable.
    await waitFor(() => cdp.eval(`!document.querySelector(".atbl")`), { what: "the picked chart" });
  };
  /** Active view mode, plus each rail bar's chips marked `*` when enabled. */
  const state = () =>
    cdp.eval(`(() => {
      // Scoped to the View toggle's own four options: segmented__item is the app's generic
      // segmented control, and the file tabs and the Relative/Linear toggles use it too.
      const mode = [...document.querySelectorAll(".segmented__item")]
        .filter((b) => ["Channel", "Fluorophore", "Target", "Table"].includes(b.textContent.trim()))
        .filter((b) => b.className.includes("is-active"))
        .map((b) => b.textContent.trim());
      const bar = (name) => {
        const s = [...document.querySelectorAll(".rail__section")]
          .find((e) => (e.querySelector(".rail__title")?.textContent || "").includes(name));
        return s ? [...s.querySelectorAll(".chanchip")]
          .map((b) => b.textContent.trim().replace(/\\s+/g, " ") + (b.className.includes("is-on") ? "*" : "")) : null;
      };
      return {
        mode,
        wells: [...document.querySelectorAll(".wm-cell.is-on")].length,
        charting: !document.querySelector(".atbl"),
        targets: bar("Target") ?? bar("Fluoro"),
        samples: bar("Sample"),
      };
    })()`);
  /** The Wells reset button, to undo an isolate — the rail's bars follow the enabled wells, so a
   * one-well selection would otherwise mask what the target/sample picks did. */
  const onWells = () => cdp.eval(`document.querySelectorAll(".wm-cell.is-on").length`);
  const resetWells = async () => {
    // Not every `.wm-cell` is selectable, so "all of them are on" is the wrong finish line —
    // what the callers depend on is that the isolate has been undone, i.e. the count moved.
    const isolated = await onWells();
    await cdp.eval(
      `(() => { [...document.querySelectorAll(".rail__section")]
          .find((s) => (s.querySelector(".rail__title")?.textContent || "").includes("Wells"))
          ?.querySelector(".rail__icon-btn").click(); })()`,
    );
    await waitValue(onWells, (n) => n !== isolated);
  };

  await toTable();
  const cells = await pickers();
  check(
    "Well, Sample, Target and the three result numbers are pickers",
    cells.length === 6,
    cells.join(" | "),
  );
  check(
    "…and they carry a pointer cursor",
    (await cdp.eval(
      `getComputedStyle(document.querySelector(".atbl tbody tr .atbl__pick")).cursor`,
    )) === "pointer",
  );

  await clickPicker(0);
  const afterWell = await state();
  check("clicking a Well leaves the table for the chart", afterWell.charting && !!afterWell.mode);
  check("…in Target view", JSON.stringify(afterWell.mode) === '["Target"]', JSON.stringify(afterWell.mode));
  check("…with that one well selected", afterWell.wells === 1, `${afterWell.wells} wells`);

  await resetWells();
  await toTable();
  // No `resetWells` here, unlike after the Well pick above: a Sample pick does not isolate wells —
  // that is the very claim "…and leaves the other dimensions alone" makes below. Asking for a reset
  // that has nothing to undo just waits out `waitValue`'s full timeout for a change that never
  // comes, which cost this group 8 s per call.
  await clickPicker(1);
  const afterSample = await state();
  check(
    "clicking a Sample isolates it in Target view",
    JSON.stringify(afterSample.mode) === '["Target"]' &&
      afterSample.samples.filter((s) => s.endsWith("*")).length === 1 &&
      afterSample.samples.length > 1,
    JSON.stringify(afterSample.samples),
  );
  check(
    "…and leaves the other dimensions alone",
    afterSample.targets.every((t) => t.endsWith("*")),
    JSON.stringify(afterSample.targets),
  );

  await toTable();
  await clickPicker(2);
  const afterTarget = await state();
  check(
    "clicking a Target isolates it in Target view",
    JSON.stringify(afterTarget.mode) === '["Target"]' &&
      afterTarget.targets.filter((t) => t.endsWith("*")).length === 1 &&
      afterTarget.targets.length > 1,
    JSON.stringify(afterTarget.targets),
  );

  // The three result numbers isolate a *curve* — both dimensions at once — rather than one of
  // them, which is the whole difference between them and the Well/Target pickers above.
  await toTable();
  const rowIdentity = await cdp.eval(
    `[...document.querySelector(".atbl tbody tr").querySelectorAll(".atbl__pick")].slice(0, 3)
        .map((b) => b.textContent.trim())`,
  );
  await clickPicker(3);
  const afterCq = await state();
  check(
    "clicking a Cq charts that one curve: its well alone…",
    JSON.stringify(afterCq.mode) === '["Target"]' && afterCq.wells === 1,
    `${afterCq.wells} wells, mode ${JSON.stringify(afterCq.mode)}`,
  );
  await resetWells();
  const afterCqReset = await state();
  check(
    "…and its target alone",
    afterCqReset.targets.filter((t) => t.endsWith("*")).length === 1 &&
      afterCqReset.targets.find((t) => t.endsWith("*"))?.startsWith(rowIdentity[2]),
    `${rowIdentity[2]} → ${JSON.stringify(afterCqReset.targets)}`,
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
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  await clickUntil(
    cdp,
    "Table",
    () => cdp.eval(`!!document.querySelector(".atbl")`),
    "the analysis table",
  );

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
  const beforeClamp = await readout();
  await drag("lo", top);
  const clamped = await waitValue(readout, (r) => r !== beforeClamp);
  check(
    "the lower handle clamps at the upper instead of crossing it",
    clamped === `${lastCycle - 10}–${lastCycle - 10}`,
    clamped,
  );

  check("the reset link restores the full range", (await reset()) === "ok");
  await waitFor(async () => (await cqs()).length === all.length, { what: "the reset to apply" });
  check("reset shows every row again", (await cqs()).length === all.length, await readout());

  // The top stop's other half: the lower handle parked there leaves only the no-Cq rows, which
  // is the "what never amplified?" question no other control in the rail can ask.
  await drag("lo", top);
  const only = await waitValue(cqs, (c) => c.length !== all.length);
  check(
    "the lower handle on the top stop leaves only the no-Cq rows",
    only.length === noCq && only.every((v) => v === "—"),
    only.join(" "),
  );
  check("that state reads as its own thing, not a range", (await readout()) === "no Cq only", await readout());

  await reset();
  // Channel space has no Cq table of its own (see `CurvesView`'s `channelAnalysis`), so the
  // control is absent there rather than present and inert.
  await clickButton(cdp, "Channel");
  // The absence of the control is the claim, so what says the app has finished responding to the
  // click is the mode itself having changed — not an interval long enough to hope it has.
  await waitFor(
    () =>
      cdp.eval(
        `[...document.querySelectorAll(".segmented__item")]
           .some((b) => b.textContent.trim() === "Channel" && b.classList.contains("is-active"))`,
      ),
    { what: "Channel to be the active space" },
  );
  check(
    "channel mode has no Cq filter",
    (await cdp.eval(`!!document.querySelector(".cq-range")`)) === false,
  );

  cdp.close();
}

/**
 * Dragging a Cq ring on the chart to set that one curve's threshold (`CurveChart`'s `onCqDrag`).
 *
 * Every part of this is invisible to a screenshot and to the core suite: that the ring is grabbable
 * at all, that the gesture opens and scrolls to the right row in the rail rather than editing a
 * number nobody can see, and — the actual arithmetic — that the threshold the drag sets is the one
 * whose line passes through where the pointer let go, which is what makes the ring appear to follow
 * the mouse. It has to be driven with real `Input.dispatchMouseEvent`s: the drag is a
 * mousedown-on-the-plot/mousemove-on-the-window pair, and a synthesized event skips the
 * capture-phase interception that keeps uPlot from starting a zoom selection instead.
 */
async function cqDragChecks(chrome, origin) {
  console.log("\ncurves chart (dragging a Cq marker)");
  const cdp = await openPage(chrome.base, origin);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".chanbar")`), { what: "curves rail" });
  // Every plotted curve's ring, not just the first: the rings arrive with the chart's own render,
  // and grabbing one mid-render would measure a position that is about to move.
  await waitFor(
    () => cdp.eval(`document.querySelectorAll(".u-over svg circle").length >= 5`),
    { what: "Cq rings" },
  );

  /** Every Cq ring's center, in viewport coordinates — what a mouse event is addressed with. */
  const rings = () =>
    cdp.eval(`[...document.querySelectorAll(".u-over svg circle")].map((c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })`);
  const mouse = (type, x, y) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
    });

  const before = await rings();
  check("the chart draws Cq rings", before.length > 0, `${before.length} rings`);
  // The middle ring by height, so the drag has curve above it and below it either way.
  const target = [...before].sort((a, b) => a.y - b.y)[Math.floor(before.length / 2)];

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
    buttons: 0,
  });
  const cursor = await waitValue(
    () => cdp.eval(`document.querySelector(".u-over").style.cursor`),
    (c) => c === "ns-resize",
  );
  check("hovering a ring offers a drag cursor", cursor === "ns-resize", cursor || "(none)");
  const openBefore = await cdp.eval(
    `[...document.querySelectorAll("details")].some((d) => d.open &&
       /Threshold/.test(d.querySelector("summary")?.textContent ?? ""))`,
  );
  check("the Threshold section starts closed", openBefore === false);

  const DY = 60;
  await mouse("mousePressed", target.x, target.y);
  for (let dy = 10; dy <= DY; dy += 10) {
    await mouse("mouseMoved", target.x, target.y - dy);
    // Pacing a drag, not waiting for a state: a real pointer emits moves spread over time, and a
    // burst delivered in one tick is coalesced into a single jump that never exercises the
    // drag's intermediate frames. There is no condition to wait for between two moves.
    await sleep(90);
  }
  await waitFor(
    () => cdp.eval(`!!document.querySelector(".analysis__threshold-row--curve.is-revealed")`),
    { what: "the dragged curve's threshold row" },
  );

  const revealed = await cdp.eval(`(() => {
    const row = document.querySelector(".analysis__threshold-row--curve.is-revealed");
    if (!row) return null;
    const rail = row.closest(".curves__rail").getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      well: row.querySelector(".analysis__threshold-well")?.textContent.trim() ?? "",
      klass: row.querySelector("input")?.className ?? "",
      open: !!row.closest("details")?.open,
      inView: r.top >= rail.top - 1 && r.bottom <= rail.bottom + 1,
    };
  })()`);
  check("the drag opens the Threshold section", revealed?.open === true, JSON.stringify(revealed));
  check("…on the dragged well's own row", !!revealed?.well, revealed?.well ?? "no row");
  check("…scrolled into view in the rail", revealed?.inView === true);
  check(
    "…showing the value as an override, not an auto threshold",
    /is-override/.test(revealed?.klass ?? ""),
    revealed?.klass,
  );

  // A higher threshold is crossed *later*, so the ring rides up to the pointer's row and to the
  // right along its own curve. The row is the assertion — that is the threshold the drag set.
  const during = await rings();
  const landed = during.filter((r) => Math.abs(r.y - (target.y - DY)) < 4);
  check(
    "the ring follows the pointer",
    landed.length === 1 && landed[0].x > target.x,
    `ring at ${JSON.stringify(landed[0])}, grabbed at ${JSON.stringify(target)}`,
  );

  // While the gesture runs, the plot's own cursor apparatus is off: uPlot sees a mouse crossing
  // the plot and would otherwise track it — a vertical rule, a hover point on every series and the
  // tooltip — all of it re-created on each of the frames the drag rebuilds, which flickered.
  const quiet = await cdp.eval(`({
    overEvents: getComputedStyle(document.querySelector(".u-over")).pointerEvents,
    points: [...document.querySelectorAll(".u-cursor-pt")]
      .filter((p) => getComputedStyle(p).display !== "none").length,
    rules: [...document.querySelectorAll(".u-cursor-x, .u-cursor-y")]
      .filter((l) => getComputedStyle(l).display !== "none").length,
    tooltip: !!document.querySelector(".chart__tip"),
  })`);
  check(
    "the drag silences the chart's own cursor",
    quiet.overEvents === "none" && quiet.points === 0 && quiet.rules === 0 && !quiet.tooltip,
    JSON.stringify(quiet),
  );

  await mouse("mouseReleased", target.x, target.y - DY);
  check(
    "releasing ends the drag",
    (await waitValue(
      () => cdp.eval(`document.body.classList.contains("is-cqdrag")`),
      (v) => v === false,
    )) === false,
  );
  // The other half of that: a drag must not leave the plot permanently deaf to the mouse.
  //
  // Re-dispatched until it takes, rather than sent once. A real pointer emits a stream of moves,
  // and the drag's teardown finishes a frame or two after `is-cqdrag` clears — a single
  // synthesized move arriving inside that window lands on a plot whose `pointerEvents` is still
  // `none`, is dropped, and nothing else ever comes to re-arm the cursor.
  const revive = async () => {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x - 40,
      y: target.y,
      buttons: 0,
    });
    return cdp.eval(`!!document.querySelector(".chart__tip")`);
  };
  await waitFor(revive, { timeout: 8000, what: "the chart's cursor to revive" });
  const revived = await cdp.eval(`({
    overEvents: getComputedStyle(document.querySelector(".u-over")).pointerEvents,
    points: [...document.querySelectorAll(".u-cursor-pt")]
      .filter((p) => getComputedStyle(p).display !== "none").length,
    tooltip: !!document.querySelector(".chart__tip"),
  })`);
  check(
    "…and hovering the plot works again",
    revived.overEvents !== "none" && revived.points > 0 && revived.tooltip,
    JSON.stringify(revived),
  );
  check(
    "…and clears the row's drag marker",
    (await cdp.eval(`!!document.querySelector(".analysis__threshold-row--curve.is-revealed")`)) ===
      false,
  );
  // The override outlives the gesture — it is a threshold the run now carries, undone with the
  // row's own reset button like any other.
  check(
    "the threshold it set stays set",
    (await cdp.eval(`document.querySelectorAll(".analysis__thresholds input.is-override").length`)) >
      0,
  );

  // Channel space has no per-curve threshold to set and no rings to grab (see `channelAnalysis`).
  await clickButton(cdp, "Channel");
  await waitValue(
    () => cdp.eval(`document.querySelectorAll(".u-over svg circle").length`),
    (n) => n === 0,
  );
  check(
    "channel mode has no Cq rings to drag",
    (await cdp.eval(`document.querySelectorAll(".u-over svg circle").length`)) === 0,
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
  const soloCols = await waitValue(refOn, (n) => n !== allCols);
  const soloCurves = await curveCount();
  check(
    "double-clicking a reference column isolates it",
    soloCols === 1 && soloCurves < allCurves,
    `${allCols}→${soloCols} columns on, ${allCurves}→${soloCurves} curves`,
  );

  // Hovering one of the columns just turned off shows it again — but only while hovered.
  await hover(refChip(3));
  const peeked = await waitValue(curveCount, (n) => n !== soloCurves);
  await hover(null);
  const unpeeked = await waitValue(curveCount, (n) => n !== peeked);
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

  const beforeDark = await stat();
  check("the Reference rail offers a dark overlay switch", (await clickSwitch("Show dark")) === "ok");
  const withDark = await waitValue(stat, (v) => v !== beforeDark);
  check(
    "Show dark overlays the run's DARKDATA channels in the Raw baseline",
    /\+ \d+ dark/.test(withDark),
    withDark.trim(),
  );

  // The factory overlay is a *drawing* toggle: the values behind it also drive the ΔRFU and
  // Drift % baselines, so hiding the line must not empty them (that would silently break both
  // modes). Turning it back on has to restore the line, not just the count.
  check("the Reference rail offers a factory overlay switch", (await clickSwitch("Show factory")) === "ok");
  const factoryOff = await waitValue(stat, (v) => v !== withDark);
  await clickSwitch("Show factory");
  const factoryOn = await waitValue(stat, (v) => v !== factoryOff);
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
  const cycleAll = await waitValue(curveCount, (n) => n !== soloCurves);
  check("the Reference rail offers the Column x axis", (await clickBaseline("Column")) === "ok");
  const colStat = await waitValue(stat, (v) => /reference columns/.test(v));
  const colCount = await curveCount();
  check(
    "Column mode collapses each column's curve into one line per channel",
    /reference columns/.test(colStat) && colCount < cycleAll && colCount > 0,
    `${cycleAll} curves over cycles → ${colCount} lines over columns`,
  );
  // ΔRFU still works in column mode — which it would not if hiding the factory line had
  // emptied the array the baseline reads.
  await clickBaseline("ΔRFU");
  const colDelta = await waitValue(stat, (v) => v !== colStat);
  check(
    "column mode still baselines against the factory values",
    /ΔRFU from factory/.test(colDelta),
    colDelta.trim(),
  );
  await clickBaseline("Raw");
  await waitValue(stat, (v) => v !== colDelta);
  check("the Reference rail returns to the Cycle x axis", (await clickBaseline("Cycle")) === "ok");
  const cycleStat = await waitValue(stat, (v) => !/reference columns/.test(v));

  check("the Reference rail offers the ΔRFU baseline", (await clickBaseline("ΔRFU")) === "ok");
  const deltaStat = await waitValue(stat, (v) => v !== cycleStat);
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
  const deltaBands = await waitValue(bandCount, (n) => n !== noBands);
  check(
    "min/max bands draw under the factory-relative baseline too",
    noBands === 0 && deltaBands > 0,
    `${noBands} → ${deltaBands} band paths`,
  );
  await clickBaseline("Column");
  const colBands = await waitValue(bandCount, (n) => n !== deltaBands);
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

/**
 * The Wells grid's row/column headers as hover and double-click targets: hovering one peeks at
 * that whole row/column of wells on the chart, and double-clicking it isolates them — the same
 * two gestures a single cell offers for one well. Invisible to a screenshot — the peek is
 * transient, and a chart with more curves on it looks the same however they got there.
 */
async function wellHeaderChecks(chrome, origin) {
  console.log("\ncurves rail (well row/column headers)");
  const cdp = await openPage(chrome.base, origin);
  await loadFile(cdp, ZPCR);
  await waitFor(() => cdp.eval(`!!document.querySelector(".wm-cell")`), { what: "the well grid" });

  /** Plotted-curve count, off the rail's own count line ("N / M curves"). */
  const curveCount = async () =>
    Number(
      /^(\d+)/.exec((await cdp.eval(`document.querySelector(".rail__stat").textContent`)).trim())?.[1] ??
        -1,
    );
  const cellsOn = () => cdp.eval(`document.querySelectorAll(".wm-cell.is-on").length`);
  const peeked = () => cdp.eval(`document.querySelectorAll(".wm-cell.is-peek").length`);

  /**
   * The grid's shape, one loaded well to isolate, and a *second* loaded well whose row and column
   * are the ones to hover. Both come from the plate rather than being hardcoded: this sample
   * loads four wells out of the 96, so an arbitrary row or column is usually empty — hovering
   * that marks its cells but adds no curves, which is correct behavior and a useless assertion.
   * Peeking at a row/column holding a well that is *not* the isolated one is what makes "more
   * curves appeared" mean something, whatever shape the loaded set happens to be.
   */
  const grid = await cdp.eval(`(() => {
    const rowEls = [...document.querySelectorAll(".wm-row")];
    const cols = rowEls[0].children.length - 1;
    const on = [...document.querySelectorAll(".wm-cell")]
      .map((c, i) => (c.className.includes("is-on") ? i : -1)).filter((i) => i >= 0);
    return {
      rows: rowEls.length, cols, loaded: on.length, solo: on[0] ?? -1,
      row: Math.floor((on[1] ?? -1) / cols), col: (on[1] ?? -1) % cols,
    };
  })()`);
  /** `.wm-head` runs every column header first, then one per row. */
  const colHead = (c) => `document.querySelectorAll(".wm-head")[${c}]`;
  const rowHead = (r) => `document.querySelectorAll(".wm-head")[${grid.cols} + ${r}]`;
  // See `referenceChecks`' own `hover`: React needs a real over/out pair, so the peek only fires
  // for an actual `Input.dispatchMouseEvent`.
  // Hovering a header marks its cells and hovering away unmarks them, so the marked count is the
  // peek's own signal — waited on here rather than slept through. The checks below still assert
  // *how many* cells were marked and what happened to the curve count; this only waits for the
  // peek to have happened at all.
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
    await waitValue(peeked, (n) => (sel ? n > 0 : n === 0), {
      what: sel ? "the hovered header's cells to be marked" : "the peek to clear",
    });
  };

  // Isolate one loaded well, so the curves a hovered header adds are unambiguously the peek's.
  await cdp.eval(`(document.querySelectorAll(".wm-cell")[${grid.solo}]
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), undefined)`);
  // Isolating means "every other well went off", so the count moving is the signal; the check
  // below still asserts what it moved *to*.
  await waitValue(cellsOn, (n) => n === 1, { what: "the double-clicked well to be the only one on" });
  const soloWells = await cellsOn();
  const soloCurves = await curveCount();
  check(
    "double-clicking a well isolates it",
    soloWells === 1 && soloCurves > 0 && grid.loaded > 1,
    `${soloWells} wells on, ${soloCurves} curves, ${grid.loaded} wells loaded`,
  );

  await hover(rowHead(grid.row));
  const rowCurves = await curveCount();
  const rowMarked = await peeked();
  await hover(null);
  const afterRow = await curveCount();
  check(
    "hovering a row header peeks at the whole row, and only while hovered",
    rowCurves > soloCurves && rowMarked === grid.cols && afterRow === soloCurves,
    `${soloCurves} → ${rowCurves} curves (${rowMarked} cells marked) → ${afterRow}`,
  );

  await hover(colHead(grid.col));
  const colCurves = await curveCount();
  const colMarked = await peeked();
  await hover(null);
  const afterCol = await curveCount();
  check(
    "hovering a column header peeks at the whole column, and only while hovered",
    colCurves > soloCurves && colMarked === grid.rows && afterCol === soloCurves,
    `${soloCurves} → ${colCurves} curves (${colMarked} cells marked) → ${afterCol}`,
  );

  // The selection itself is untouched: hovering shows wells, it never turns them on.
  check("…without changing which wells are selected", (await cellsOn()) === soloWells);

  // Double-click follows the same grain as hover: a header isolates its whole row/column, exactly
  // as a cell isolates one well. The pair of clicks a double-click also fires toggles the group on
  // and straight back off, so the solo is what survives.
  // `want` is the count the isolate should leave, so the wait is for the selection to arrive at
  // it; the check then says what that count *means* (a whole row, a whole column).
  const dblclick = async (sel, want) => {
    await cdp.eval(`(${sel}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), undefined)`);
    await waitValue(cellsOn, (n) => n === want, { what: `the isolate to leave ${want} wells on` });
  };
  await dblclick(rowHead(grid.row), grid.cols);
  check(
    "double-clicking a row header isolates that row",
    (await cellsOn()) === grid.cols,
    `${await cellsOn()} wells on, expected ${grid.cols}`,
  );
  await dblclick(colHead(grid.col), grid.rows);
  check(
    "double-clicking a column header isolates that column",
    (await cellsOn()) === grid.rows,
    `${await cellsOn()} wells on, expected ${grid.rows}`,
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
      `JSON.stringify([...document.querySelectorAll('.viewbar [role="tab"]')]
         .map((b) => ({ label: b.textContent.trim(), off: b.disabled })))`,
    )
    .then(JSON.parse);
  check(
    "a locked run keeps the tab strip, with every file view disabled",
    lockedStrip.length === 9 &&
      lockedStrip.filter((t) => t.off).length === 7 &&
      !lockedStrip.find((t) => t.label === "Files").off &&
      // Instrument is not a lens on this file — or any file — so a run this browser can't open
      // has no bearing on whether there is a cycler to talk to (`ViewBar`).
      !lockedStrip.find((t) => t.label === "Instrument").off,
    JSON.stringify(lockedStrip),
  );
  locked.close();

  // Hash form: consumed, then stripped so a copied URL can't leak the secret.
  const a = await openPage(chrome.base, `${origin}#cfxPassword=${encodeURIComponent(pw)}`);
  const urlA = await waitValue(
    () => a.eval("window.location.href"),
    (u) => !/cfxPassword/i.test(u),
  );
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
  const urlB = await waitValue(
    () => b.eval("window.location.href"),
    (u) => !/cfxPassword/i.test(u),
  );
  check(
    "legacy ?cfxPassword still accepted",
    (await b.eval(`localStorage.getItem("zpcr:pltdPassword")`)) === pw,
  );
  check("legacy query password stripped", !/cfxPassword/i.test(urlB), urlB.replace(origin, "/"));
  check("unrelated query params preserved", /keep=1/.test(urlB));

  // And it must never reappear in the routing hash written after hydration.
  await loadFile(b, ZPCR);
  const hashB = await waitValue(() => b.eval("window.location.hash"), (h) => /file=/.test(h));
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
 * The raw viewer's download button in **Hex** mode: the entry's stored bytes, verbatim, under the
 * entry's own name (`components/views/RawFilesView.tsx`). The other two modes download something
 * derived — a CSV of the decoded table, the decrypted/plain text — so this is the only one where
 * "byte for byte" is the contract, and the only way to see it is to catch the download itself.
 *
 * Nothing in the app is instrumented for that: the check listens for the click on the anchor
 * `downloadBytes` creates, cancels the navigation, and reads the blob back with a *synchronous*
 * XHR. Synchronous because `downloadBytes` revokes the object URL as soon as `click()` returns,
 * so anything asynchronous is racing a URL that is already gone; `charset=x-user-defined` is what
 * makes a text response carry arbitrary bytes intact.
 */
async function rawHexDownloadChecks(chrome, origin) {
  console.log("\nRaw hex download");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, ZPCR);
  await cdp.eval(`window.location.hash = "view=raw", undefined`);
  await tabBecomes(cdp, "Raw");

  // What the archive actually holds, read here rather than in the browser — an assertion against
  // the app's own copy of the bytes could only ever agree with itself.
  const { unzipArchive } = await import("../packages/core/dist/index.js");
  const files = unzipArchive(new Uint8Array(readFileSync(ZPCR)));
  // A `.Dcal`: binary, so Hex is its default mode, and big enough that a truncated download shows.
  const entry = Object.keys(files).find((n) => /\.Dcal$/i.test(n));
  const want = files[entry];
  /** FNV-1a over the bytes — a short value that still changes if any byte does. */
  const fnv = (bytes) => {
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    return h;
  };

  await cdp.eval(`(() => {
    window.__dl = null;
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[download]');
      if (!a) return;
      e.preventDefault();
      const x = new XMLHttpRequest();
      x.open('GET', a.href, false);
      x.overrideMimeType('text/plain; charset=x-user-defined');
      x.send();
      let h = 0x811c9dc5;
      for (let i = 0; i < x.responseText.length; i++) {
        h = Math.imul(h ^ (x.responseText.charCodeAt(i) & 0xff), 0x01000193) >>> 0;
      }
      window.__dl = { name: a.download, size: x.responseText.length, hash: h };
    }, true);
    return undefined;
  })()`);

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
  // Anchor on the toolbar naming this entry before touching the mode buttons: until it does, a
  // click on Hex would be switching the *previous* file's viewer.
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
        `(() => { const b = [...document.querySelectorAll('.raw__modes .segmented__item')]
            .find(x => x.textContent.trim() === 'Hex');
          if (!b) return false;
          if (!b.classList.contains("is-active")) b.click();
          return b.classList.contains("is-active"); })()`,
      ),
    { what: `${entry} in Hex mode` },
  );

  const disabled = await cdp.eval(`!!document.querySelector('.raw__download')?.disabled`);
  check("the download button is live in Hex mode", disabled === false, `disabled=${disabled}`);

  await cdp.eval(`document.querySelector('.raw__download').click(), undefined`);
  const got = await waitValue(
    () => cdp.eval(`JSON.stringify(window.__dl)`).then((s) => JSON.parse(s ?? "null")),
    (v) => v !== null,
    { what: "the hex download to fire" },
  );
  check(
    "Hex downloads the entry's bytes, all of them and unchanged",
    got?.size === want.length && got?.hash === fnv(want),
    `${got?.size} B / hash ${got?.hash} vs ${want.length} B / hash ${fnv(want)}`,
  );
  check(
    "…under the archive entry's own name",
    got?.name === entry,
    `${got?.name} vs ${entry}`,
  );
  cdp.close();
}

/**
 * The `.alf` run report's decoded view inside an archive (`alf.md`,
 * `components/raw/DecodedAlf.tsx`).
 *
 * What this view is: the run's *identity and outcome* — the header fields and error flags pulled
 * apart and named — followed by the executed-step log, one row per line of it. What it deliberately
 * is not is a second rendering of the protocol: that is the Protocol tab's, as the annotated
 * listing, and having it here as well meant one protocol read twice into two shapes that could only
 * agree or be a bug. The step log is not a duplicate of the same kind — the Protocol tab plots it
 * as a thermal profile, while this is where the literal per-line contents are.
 *
 * The derived numbers are asserted, because losing them silently is the failure worth catching:
 * the log's heading counts the steps and plate reads it holds, and its `Plate read` rows have to
 * be 1:1 with the archive's own `.Plateread` entries (§7.5 — the one claim that spans two file
 * types at once). The per-step
 * durations in the table's "Took" column are core's (`packages/core/test/alf.test.ts`), and the
 * plot of them is `thermalProfileChecks` below.
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
  await waitFor(() => cdp.eval(`!!document.querySelector('.raw__decoded .decoded__dl')`), {
    what: "the decoded run report",
  });

  const shown = await cdp
    .eval(
      `JSON.stringify({
         mode: document.querySelector('.raw__modes .segmented__item.is-active')?.textContent.trim(),
         text: (document.querySelector('.raw__decoded')?.textContent ?? "").replace(/\\s+/g, " "),
         heading: [...document.querySelectorAll('.raw__decoded .decoded__h')]
           .find(h => /^Execution log/.test(h.textContent.trim()))?.textContent.trim(),
         rows: document.querySelectorAll('.raw__decoded .decoded__alf tbody tr').length,
         cols: [...document.querySelectorAll('.raw__decoded .decoded__alf thead th')]
           .map(th => th.textContent.trim()),
         reads: [...document.querySelectorAll('.raw__decoded .decoded__alf tbody tr')]
           .filter(r => /Plate read/.test(r.children[6]?.textContent ?? '')).length,
         took: [...document.querySelectorAll('.raw__decoded .decoded__alf tbody tr')]
           .filter(r => /^\\d+:\\d\\d/.test((r.children[9]?.textContent ?? '').trim())).length,
         end: document.querySelector('.raw__decoded .decoded__alfend')?.textContent.trim(),
       })`,
    )
    .then(JSON.parse);

  check("a .alf opens on its decoded run report, not a hex dump", shown.mode === "Decoded", shown.mode);
  check(
    "the log's heading counts what it holds — steps, plate reads and stages",
    !!shown.heading && shown.heading.includes(`${plateReads} plate reads`),
    `${shown.heading} / ${plateReads} files`,
  );
  check(
    // The raw view's rule: everything the file holds. All four line roles are here, the protocol
    // (line 2) included, and an empty header field shows as ∅ rather than going missing.
    "the decoded view holds the whole file: header, protocol, errors and log",
    shown.text.includes("Base serial") &&
      shown.text.includes("Lid pressure") &&
      shown.text.includes("∅") &&
      shown.text.includes("HOTLID") &&
      shown.text.includes("User aborted") &&
      shown.text.includes("Execution log"),
    shown.text.slice(0, 300),
  );
  check(
    "…and every field of a step line has a column, the uninterpretable one included (alf.md §8)",
    ["Cycle", "Rep", "Step", "RAMPTIME", "Setpoint", "Hold", "Began", "Paused"].every((c) =>
      shown.cols.includes(c),
    ),
    JSON.stringify(shown.cols),
  );
  check(
    "the execution log is a table, one row per logged step plus the end-of-run line",
    shown.text.includes("Execution log") && shown.rows > plateReads && shown.took > 0,
    `${shown.rows} rows, ${shown.took} with a duration`,
  );
  check(
    "…whose Plate read rows are 1:1 with the archive's .Plateread files (alf.md §7.5)",
    shown.reads === plateReads,
    `${shown.reads} rows / ${plateReads} files`,
  );
  check(
    "…and whose last row is the sentinel's completion phrase (alf.md §7.3)",
    /completed/i.test(shown.end ?? ""),
    shown.end,
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
  console.log("\ninstrument runs and experiments");
  const cdp = await openPage(chrome.base, origin);
  // Earlier checks leave their own files in IndexedDB, so start from a known empty bar rather
  // than from whatever the suite happened to load last — the selection rules below are about
  // *which* chips are on, and a stray one makes every count meaningless.
  await emptyReload(cdp, origin);
  await loadFile(cdp, ZPCR);
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
  await waitFor(() => cdp.eval(`!!document.querySelector(".devrun__part")`), {
    what: "the run panel's halves",
  });

  /** The experiment as the Instrument panel renders it: each half, and what the bar shows. */
  const shown = () =>
    cdp.eval(`(() => {
      const parts = [...document.querySelectorAll(".devrun__part")].map((p) => ({
        title: p.querySelector(".devrun__parttitle").textContent.trim(),
        note: p.querySelector(".devrun__source")?.textContent.trim() || null,
        text: p.textContent,
      }));
      return {
        protocol: parts.find((p) => p.title === "Protocol") || null,
        plate: parts.find((p) => p.title === "Plate") || null,
        title: document.querySelector(".instrument__paneltitle")?.textContent.trim() || "",
        // The panel head names the experiment read-only; there is no picker here, on purpose —
        // the file bar is the app's one file picker.
        named: document.querySelector(".instrument__panelhead .devrun__hint")?.textContent.trim() ?? null,
        chips: [...document.querySelectorAll(".filebar .filechip")].map((c) => ({
          name: c.querySelector(".filechip__name").textContent.trim(),
          on: c.classList.contains("is-active"),
        })),
      };
    })()`);

  // The experiment this view is about is the app's ordinary selection — no second picker (see
  // `InstrumentRun`), so what the panel names must be exactly what the file bar has lit.
  const first = await shown();
  check(
    "the Instrument view starts the selected experiment, naming it rather than re-picking it",
    first.named !== null && first.named === (first.chips.find((c) => c.on)?.name ?? "\u0000"),
    JSON.stringify({ named: first.named, chips: first.chips }),
  );
  check(
    "…and offers no picker of its own, the file bar being the app's one file picker",
    (await cdp.eval(`document.querySelectorAll(".instrument select").length`)) === 0,
  );
  check(
    "a run supplies both halves of what would be started, from the one file",
    /METHOD CALC/.test(first.protocol.text) && /8×12/.test(first.plate.text),
    JSON.stringify({ title: first.title, hint: first.hint }),
  );

  // A run that already holds results is not startable — re-running it would either overwrite what
  // it has or contradict it — so the panel says so and offers the clone that *is* the way to run it
  // again, rather than leaving a dimmed button to explain itself.
  const withResults = await cdp.eval(`(() => {
    const btn = [...document.querySelectorAll("button")]
      .find((b) => /Clone experiment/.test(b.textContent));
    return {
      title: document.querySelector(".instrument__paneltitle")?.textContent.trim() || "",
      cloneOffered: !!btn,
      says: document.querySelector(".instrument__completeactions")?.textContent || "",
    };
  })()`);
  check(
    "a run with results reads as a record, and offers a clone rather than a start",
    /^Run/.test(withResults.title) &&
      withResults.cloneOffered &&
      /already been run/.test(withResults.says),
    JSON.stringify(withResults),
  );

  // The protocol is the program and nothing else: no per-directive gloss. It shares this panel's
  // width with a plate map, and what the language *means* is a question the Protocol tab answers
  // (checked above) — here the question is what would be sent, so every line is still numbered as
  // the instrument numbers it, setup directives included (no number).
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
    "the panel lists the directives themselves, with no decode column",
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

  // Start belongs to the instrument, not the panel, so it is absent until one is attached.
  const startWhenIdle = await cdp.eval(`!!document.querySelector(".instrument__start")`);
  check("Start appears only with an instrument connected", startWhenIdle === false);

  // No name is collected here any more, in either form. The experiment's name is a property of its
  // file, typed once on Overview before the instrument is ever involved (see `OverviewView`), so a
  // field here would be a second place to say what the file already says — and one that could
  // disagree with the name already written into the archive.
  const nameFields = await cdp.eval(
    `document.querySelectorAll(".devrun__name, .devrun__nameinput").length`,
  );
  check(
    "the panel collects no name — that belongs to the file, and Overview asks for it",
    nameFields === 0,
    `${nameFields} name fields`,
  );

  // A `.prcl.txt` goes in through the ordinary load button, not a picker of its own.
  mkdirSync(dirname(PRCL_TXT), { recursive: true });
  writeFileSync(PRCL_TXT, PRCL_TXT_BODY);
  await loadFile(cdp, PRCL_TXT);
  await waitFor(() => chipPresent(cdp, "Gradient"), { what: "the .prcl.txt chip" });
  const loadedTab = await waitValue(() => activeTab(cdp), (t) => t !== "none");

  // …and the rule the whole view now rests on: with a `.prcl.txt` selected there is no experiment,
  // so the panel shows *nothing* rather than the run that happens to have been there before. A run
  // it names must always be the run the file bar has lit — showing a different one would be the
  // single answer guaranteed to be wrong. The instrument itself is unaffected, which is why this
  // costs nothing: the rail is still there, with its connect button.
  await cdp.eval(`window.location.hash = "view=instrument", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".instrument__rail")`), {
    what: "the instrument rail",
  });
  await waitFor(() => cdp.eval(`!!document.querySelector(".instrument__panelhead, .instrument__empty")`), {
    what: "the instrument panel",
  });
  const afterProtocol = await cdp.eval(`(() => ({
    named: document.querySelector(".instrument__panelhead .devrun__hint")?.textContent.trim() ?? null,
    parts: document.querySelectorAll(".devrun__part").length,
    says: document.querySelector(".instrument__empty")?.textContent.trim() || "",
    connect: !![...document.querySelectorAll("button")].find((b) => /Connect over USB/i.test(b.textContent)),
    lit: [...document.querySelectorAll(".filebar .filechip")]
      .filter((c) => c.classList.contains("is-active"))
      .map((c) => c.querySelector(".filechip__name").textContent.trim()),
  }))()`);
  check(
    "…and with a .prcl.txt selected it shows no experiment at all, not some other run",
    afterProtocol.named === null &&
      afterProtocol.parts === 0 &&
      /No experiment selected/.test(afterProtocol.says) &&
      afterProtocol.lit.join(",") === "Gradient",
    JSON.stringify(afterProtocol),
  );
  check(
    "…while the instrument itself stays usable, which is why showing nothing costs nothing",
    afterProtocol.connect === true,
  );
  // The bar itself is free while this view is up — no locked chips, which is what the removal of
  // `activeLocked` has to actually mean on screen.
  const locked = await cdp.eval(`document.querySelectorAll(".filechip.is-locked").length`);
  check("…with no chip locked by this view being open", locked === 0, `${locked} locked chips`);
  // Back to where the protocol file's own checks below carry on from.
  await cdp.eval(`window.location.hash = "file=Gradient.prcl.txt&view=overview", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__infotable")`), {
    what: "the protocol file's Overview",
  });
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
      `JSON.stringify([...document.querySelectorAll('.viewbar [role="tab"]')]
         .map(b => ({ label: b.textContent.trim(), off: b.disabled })))`,
    )
    .then(JSON.parse);
  check(
    "a .prcl.txt enables Overview, Protocol and Raw (plus the two file-independent tabs)",
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
  // The Method/Lid/Volume/Steps/Plate-reads/Scan table this tab used to lead with is gone: every one
  // of those facts is a directive in the listing below it, annotated in plain English, so the table
  // restated the protocol in a second shorter form that could only agree with it or be a bug.
  check(
    "…and its Protocol tab leads with the protocol itself, not a table restating it",
    protoTab === "Protocol" &&
      Object.keys(protoOverview.tiles).length === 0 &&
      protoOverview.lines.length > 0,
    JSON.stringify({ tiles: protoOverview.tiles, lines: protoOverview.lines.length }),
  );
  // The name leads the view instead, the way an experiment's does on its Overview.
  const protoHeadline = await cdp.eval(
    `document.querySelector(".overview__nametext, .overview__name")?.value ??
     document.querySelector(".overview__nametext")?.textContent.trim() ?? null`,
  );
  check(
    "…under its own name as the headline",
    protoHeadline === "Gradient",
    JSON.stringify({ headline: protoHeadline }),
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
  // The same control, and so the same helper, as a `.zpcr`'s rename — this used to be a
  // byte-identical copy of {@link renameFile} carried alongside it, sleeps and all.
  await renameFile(cdp, "Gradient-renamed.prcl.txt");
  await waitFor(async () => (await protoFilename()) === "Gradient-renamed.prcl.txt", {
    what: "the protocol file's renamed Filename row",
  });
  check(
    "a .prcl.txt's filename can be renamed too, from its own Rename button",
    (await protoFilename()) === "Gradient-renamed.prcl.txt",
    await protoFilename(),
  );
  await renameFile(cdp, "Gradient.prcl.txt");
  await waitFor(async () => (await protoFilename()) === "Gradient.prcl.txt", {
    what: "the protocol file's name restored",
  });

  // ── The new workflow, end to end ──────────────────────────────────────────────────────────
  // Everything above this point is about reading a run that already exists. What follows is the
  // other half of the app: making one. Both entry points land in the same place — a *pending*
  // experiment, a real file with no results — which is the state this whole flow turns on.

  // "Clone experiment" is the way to run an experiment again. It is deliberately not a copy of the
  // file: a finished run's bulk is its results, and a second copy of those is never what was
  // wanted.
  await cdp.eval(
    `(() => { [...document.querySelectorAll(".filechip__main")]
        .find((b) => /FirstQualification/.test(b.textContent)).click(); })()`,
  );
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__clonebtn")`), {
    what: "the Overview clone button",
  });
  const chipsBeforeClone = await cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  await cdp.eval(`document.querySelector(".overview__clonebtn").click()`);
  await waitFor(
    () => cdp.eval(`document.querySelectorAll(".filebar .filechip").length > ${chipsBeforeClone}`),
    { what: "the cloned experiment's chip" },
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__infotable")`), {
    what: "the clone's Overview table",
  });

  const cloned = await cdp.eval(`(() => {
    const dl = document.querySelector(".overview__infotable");
    const info = {};
    if (dl) {
      const dts = [...dl.querySelectorAll("dt")];
      const dds = [...dl.querySelectorAll("dd")];
      dts.forEach((dt, i) => { info[dt.textContent.trim()] = dds[i].textContent.trim(); });
    }
    const name = document.querySelector(".overview__name");
    return {
      info,
      pendingBanner: !!document.querySelector(".overview__pending"),
      ready: !!document.querySelector(".overview__ready"),
      nameValue: name?.value ?? null,
      nameRequired: !!name?.required,
      nameMissing: !!name?.classList.contains("is-missing"),
      focused: document.activeElement === name,
      parts: [...document.querySelectorAll(".overview__partlabel")].map((l) => ({
        half: l.firstChild.textContent.trim(),
        state: l.querySelector("span")?.textContent.trim() ?? null,
      })),
    };
  })()`);
  // A clone arrives as a *pending* experiment: named nothing, dated today, carrying the protocol and
  // plate and none of the results. It replaces the very transitory seed file the old flow produced
  // at the click on Start — a file nobody chose to make, which existed for minutes.
  check(
    "cloning a run makes a pending experiment, said so plainly",
    cloned.pendingBanner && /\.zpcr$/.test(cloned.info.Filename ?? ""),
    JSON.stringify({ file: cloned.info.Filename, banner: cloned.pendingBanner }),
  );
  check(
    "…named nothing yet, with the field required and focused for typing",
    cloned.nameValue === "" && cloned.nameRequired && cloned.nameMissing && cloned.focused,
    JSON.stringify({
      value: cloned.nameValue,
      required: cloned.nameRequired,
      missing: cloned.nameMissing,
      focused: cloned.focused,
    }),
  );
  // The clone's file name is the bare date, deliberately not a guess at what the experiment is
  // called — there is no honest guess to make, and a placeholder that looked like an answer would
  // be typed over rather than replaced.
  check(
    "…under a bare-date file name, since nothing has named it",
    /^\d{8}\.zpcr$/.test(cloned.info.Filename ?? ""),
    cloned.info.Filename,
  );
  check(
    "…carrying the protocol and plate it was cloned from, and offering both as parts",
    cloned.parts.length === 2 &&
      cloned.parts[0].half === "Protocol" &&
      cloned.parts[0].state === "attached" &&
      cloned.parts[1].half === "Plate" &&
      cloned.parts[1].state === "attached",
    JSON.stringify(cloned.parts),
  );

  // PENDING, not INCOMPLETE. Both states hold fewer plate reads than their protocol asks for, which
  // is the arithmetic `runCompleteness` accuses a *cancelled* run on — so a pending experiment used
  // to be flagged as one. They now read as the two different things they are: one was started and
  // stopped short, the other has not been started.
  const badges = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".filebar .filechip")].map((c) => ({
         name: c.querySelector(".filechip__name").textContent.trim(),
         badge: c.querySelector(".filechip__date")?.textContent.trim() ?? null,
         pending: !!c.querySelector(".filechip__date--pending"),
         incomplete: !!c.querySelector(".filechip__date--incomplete"),
       })))`,
    )
    .then(JSON.parse);
  const pendingChip = badges.find((b) => b.pending);
  check(
    "the pending experiment's chip says PENDING, never INCOMPLETE",
    !!pendingChip && pendingChip.badge === "Pending" && !badges.some((b) => b.incomplete),
    JSON.stringify(badges),
  );
  check(
    "…while the finished run it was cloned from keeps its run date",
    badges.some(
      (b) => /FirstQualification/.test(b.name) && !b.pending && !b.incomplete && /\d/.test(b.badge ?? ""),
    ),
    JSON.stringify(badges),
  );

  // Naming an experiment names its file too, by the same convention every run's file uses. The two
  // are one action here and nowhere else: leaving `20260804.zpcr` on disk while the run is called
  // something else would have the bar, the download and the instrument's own deposit disagree
  // about which run this is.
  // Naming renames the file, so the info table's Filename row moving is the signal that the
  // rename has been through the store — `protoFilename` reads that row whatever the file is.
  const beforeNaming = await protoFilename();
  await setExperimentName(cdp, "Cloned RVP");
  await waitValue(protoFilename, (f) => f !== beforeNaming);
  const named = await cdp.eval(`(() => {
    const dl = document.querySelector(".overview__infotable");
    const dts = [...dl.querySelectorAll("dt")];
    const dds = [...dl.querySelectorAll("dd")];
    const info = {};
    dts.forEach((dt, i) => { info[dt.textContent.trim()] = dds[i].textContent.trim(); });
    return {
      file: info.Filename,
      name: document.querySelector(".overview__name")?.value ?? null,
      stillRequired: !!document.querySelector(".overview__name")?.required,
    };
  })()`);
  check(
    "naming a pending experiment renames its file to the date-and-name convention",
    /^\d{8}-Cloned_RVP\.zpcr$/.test(named.file ?? ""),
    JSON.stringify(named),
  );
  check(
    "…and the field stops being required once it has an answer",
    named.name === "Cloned RVP" && !named.stillRequired,
    JSON.stringify(named),
  );

  // Name plus protocol is everything a run needs, so the page stops asking for parts and says
  // where to go instead — the one state on Overview whose next step is on another tab. A clone
  // carries the protocol across, so naming it is the last thing missing: the box is absent above
  // (checked on `cloned`, before the name was typed) and present here.
  const ready = await cdp.eval(`(() => {
    const box = document.querySelector(".overview__ready");
    return {
      shown: !!box,
      text: box?.textContent.trim() ?? null,
      link: box?.querySelector(".overview__readylink")?.textContent.trim() ?? null,
    };
  })()`);
  check(
    "a named pending experiment with a protocol says it is ready to run",
    !cloned.ready && ready.shown && /Ready to run/.test(ready.text ?? "") && ready.link === "Instrument tab",
    JSON.stringify({ beforeNaming: cloned.ready, ...ready }),
  );
  // And the tab name in it is the way there, not just a word: this is the hand-off Overview owes
  // the Instrument tab, and the Instrument tab hands back at the click on Start.
  await cdp.eval(`document.querySelector(".overview__readylink").click()`);
  await tabBecomes(cdp, "Instrument");
  check(
    "…and its 'Instrument tab' goes to the Instrument tab",
    await cdp.eval(`!!document.querySelector(".instrument__rail")`),
    "no instrument rail after clicking the ready box's link",
  );
  // `clickTab`, not a hash write: the app is still settling into the Instrument view it was just
  // sent to, and writes the hash itself as it does. A hash write landing inside that window is
  // overwritten and the view snaps back — which is how this intermittently sat on Instrument for
  // 8 s and carried on regardless. Pressing the tab confirms it took.
  await clickTab(cdp, "Overview");
  await tabBecomes(cdp, "Overview");

  // The name is only really *given* if it outlives the session — it lives in the file's own
  // `zpcrweb.json`, not in this browser. This is the pending-experiment case specifically, and it
  // is the one that used to fail: naming one renames its file in the same breath, and the record
  // written under the new name was assembled from the in-memory archive, which deliberately carries
  // no settings entry. So the name went back to being required on the next load, and with it the
  // red field and the "required" badge (`useZpcrStore`'s `contentToStore`).
  await flushWrites(cdp);
  // Started, not awaited (see `flushWrites`) — this is the write landing, not the rate
  // limit expiring.
  await sleep(200);
  await cdp.send("Page.navigate", {
    url: `${origin}#file=${encodeURIComponent(named.file)}&view=overview`,
  });
  await tabBecomes(cdp, "Overview");
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__name")`), {
    what: "the reloaded name field",
  });
  const afterReload = await cdp.eval(`(() => {
    const el = document.querySelector(".overview__name");
    return {
      name: el?.value ?? null,
      stillRequired: !!el?.required,
      badge: !!document.querySelector(".overview__namerequired"),
    };
  })()`);
  check(
    "…and the name outlives the reload, rather than going back to required",
    afterReload.name === "Cloned RVP" && !afterReload.stillRequired && !afterReload.badge,
    JSON.stringify(afterReload),
  );

  // A pending experiment's Protocol tab is an *editor*, not a record — that is the difference the
  // pending state buys, and what makes "write a protocol from scratch" possible without authoring a
  // separate file first. A run that has happened gets the read-only listing instead.
  await cdp.eval(`window.location.hash = "view=protocol", undefined`);
  await tabBecomes(cdp, "Protocol");
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__blockhead, .decoded__protoline, .protoedit")`), {
    what: "the Protocol tab's body",
  });
  // Asserting the editor is *usable*, not merely present: the Edit button renders either way, and
  // the bug this pins had it rendering disabled with "Not editable: Unrecognized directive
  // "[ProtocolRunDefinition version 06.00]"" — the archive entry had been written in the `.prcl.txt`
  // file form, header and all, which `ProtocolBuilder` rightly refuses (see core's `attachProtocol`).
  const editable = await cdp
    .eval(
      `JSON.stringify((() => {
         // The pencil, by its accessible label — it has no text to match on any more.
         const btn = [...document.querySelectorAll("button")]
           .find((b) => /^Edit this protocol$/.test(b.getAttribute("aria-label") ?? ""));
         return {
           present: !!btn,
           enabled: !!btn && !btn.disabled,
           refusal: document.querySelector(".protoedit__note")?.textContent.trim() ?? null,
           lines: [...document.querySelectorAll(".decoded__prototext")].map((l) => l.textContent.trim()),
         };
       })())`,
    )
    .then(JSON.parse);
  check(
    "a pending experiment's protocol can be edited in place",
    editable.present && editable.enabled && editable.refusal === null,
    JSON.stringify({ enabled: editable.enabled, refusal: editable.refusal }),
  );
  check(
    "…and its protocol entry carries no .prcl.txt header to choke the builder",
    editable.lines.length > 0 && !editable.lines.some((l) => /^\[ProtocolRunDefinition/.test(l)),
    JSON.stringify(editable.lines.slice(0, 4)),
  );

  // The three the Plates tab carries for a plate, on the protocol's own heading line: replace,
  // download, clone. They pin the mirror itself — the pair used to exist only on the read-only
  // listing, so a pending experiment's protocol could be edited but neither saved out nor swapped.
  const protoTools = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".overview__blocktools > *")].map((el) =>
         el.tagName === "DETAILS"
           ? el.querySelector("summary")?.getAttribute("aria-label") ?? "menu"
           : el.getAttribute("aria-label") ?? el.textContent.trim()))`,
    )
    .then(JSON.parse);
  check(
    "a pending experiment's protocol can be replaced, downloaded and cloned from its own tab",
    protoTools[0] === "replace protocol" &&
      /^Download the thermal protocol/.test(protoTools[1] ?? "") &&
      /^Clone the thermal protocol/.test(protoTools[2] ?? ""),
    JSON.stringify(protoTools),
  );

  // …and what that Replace offers is *protocols*, not protocol files: the ones inside the other
  // loaded runs, by name, with the run they live in beneath. Nothing in this session has ever
  // written a standalone `.prcl.txt`, so a menu listing only top-level files would be empty here —
  // which is exactly the ceremony (open the run, clone its protocol out, come back) this removes.
  await cdp.eval(
    `document.querySelector(".overview__blocktools .dlmenu > summary").click(), undefined`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__blocktools .dlmenu__item")`), {
    what: "the download menu's items",
  });
  const offered = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".overview__blocktools .dlmenu__item")]
         .filter((b) => !b.disabled && b.textContent.trim() !== "Upload…")
         .map((b) => ({
           label: b.firstChild?.textContent?.trim() ?? "",
           from: b.querySelector(".dlmenu__from")?.textContent.trim() ?? null,
         })))`,
    )
    .then(JSON.parse);
  await cdp.eval(
    `document.querySelector(".overview__blocktools .dlmenu > summary").click(), undefined`,
  );
  check(
    "replace protocol offers the protocols inside other loaded runs, named and attributed",
    offered.length > 0 && offered.every((o) => o.label) && offered.some((o) => /^in \S/.test(o.from ?? "")),
    JSON.stringify(offered),
  );
  check(
    "…and never this experiment's own protocol, which would be a no-op behind a warning",
    // The file this experiment was renamed to above — see the date-and-name check.
    !offered.some((o) => /Cloned_RVP/.test(o.from ?? "")),
    JSON.stringify(offered.map((o) => o.from)),
  );

  // Starting it is blocked only by things that are actually missing — and a plate is not one of
  // them. An experiment may deliberately be run without one (the curves simply carry no target or
  // sample names), so that is a warning rather than a blocker.
  await cdp.eval(`window.location.hash = "view=instrument", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".devrun")`), { what: "the run panel" });
  await waitFor(() => cdp.eval(`!!document.querySelector(".instrument__paneltitle")`), {
    what: "the run panel's title",
  });
  const pendingPanel = await cdp.eval(`(() => ({
    title: document.querySelector(".instrument__paneltitle")?.textContent.trim() || "",
    named: document.querySelector(".instrument__panelhead .devrun__hint")?.textContent.trim() || "",
    cloneOffered: [...document.querySelectorAll("button")].some((b) =>
      /Clone experiment/.test(b.textContent)),
  }))()`);
  check(
    "a pending experiment reads as one to start, under its own name",
    /Experiment to start/.test(pendingPanel.title) && /Cloned RVP/.test(pendingPanel.named),
    JSON.stringify(pendingPanel),
  );
  check(
    "…and is not offered the clone that a run with results is",
    pendingPanel.cloneOffered === false,
    JSON.stringify(pendingPanel),
  );

  // "New experiment" from the About page is the other way in: the same pending state, with neither
  // half — which is where someone with a cycler and no files at all starts.
  await cdp.eval(`window.location.hash = "view=about", undefined`);
  await waitFor(
    () =>
      cdp.eval(
        `[...document.querySelectorAll("button")].some((b) => /New experiment/.test(b.textContent))`,
      ),
    { what: "the New experiment button" },
  );
  await cdp.eval(
    `(() => { [...document.querySelectorAll("button")]
        .find((b) => /New experiment/.test(b.textContent)).click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__pending")`), {
    what: "the new experiment's pending banner",
  });
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__infotable")`), {
    what: "the new experiment's Overview table",
  });
  const fresh = await cdp.eval(`(() => {
    const dl = document.querySelector(".overview__infotable");
    const dts = [...dl.querySelectorAll("dt")];
    const dds = [...dl.querySelectorAll("dd")];
    const info = {};
    dts.forEach((dt, i) => { info[dt.textContent.trim()] = dds[i].textContent.trim(); });
    return {
      protocol: info.Protocol,
      parts: [...document.querySelectorAll(".overview__partlabel")].map((l) => ({
        half: l.firstChild.textContent.trim(),
        state: l.querySelector("span")?.textContent.trim() ?? null,
      })),
      tabs: [...document.querySelectorAll('.viewbar [role="tab"]')]
        .filter((b) => !b.disabled)
        .map((b) => b.textContent.trim()),
    };
  })()`);
  check(
    "New experiment makes an empty pending experiment, with neither half attached",
    /not set yet/.test(fresh.protocol ?? "") &&
      fresh.parts.some((p) => p.half === "Protocol" && p.state === "required to start") &&
      fresh.parts.some((p) => p.half === "Plate" && p.state === "optional"),
    JSON.stringify(fresh.parts),
  );
  // Protocol is enabled even with nothing in it — there it is where a from-scratch experiment's
  // protocol comes from. Plates is not: attaching one is an Overview affordance while pending.
  check(
    "…offering Overview and Protocol, but not the tabs it has nothing for",
    fresh.tabs.includes("Overview") &&
      fresh.tabs.includes("Protocol") &&
      !fresh.tabs.includes("Plates") &&
      !fresh.tabs.includes("Curves"),
    JSON.stringify(fresh.tabs),
  );

  // The archive really is empty. An earlier version wrote a zero-length `ProtocolRunDefinition.txt`
  // so the file would parse, and the Protocol tab synthesised a default protocol to show — so a
  // brand-new experiment claimed a protocol it didn't have, in the archive *and* on screen. Its own
  // `zpcrweb.json` is what identifies it now (`zpcr.ts`).
  await clickTab(cdp, "Raw");
  await tabBecomes(cdp, "Raw");
  await waitFor(() => cdp.eval(`!!document.querySelector(".raw__item")`), {
    what: "the Raw tab's entry list",
  });
  const entries = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".raw__item")].map((i) => i.textContent.trim()))`,
    )
    .then(JSON.parse);
  check(
    "…holding no protocol entry at all, just the settings entry that identifies the archive",
    entries.length === 1 && /zpcrweb\.json/.test(entries[0]),
    JSON.stringify(entries),
  );

  // …and its Protocol tab says where a protocol comes from rather than showing a default one.
  await clickTab(cdp, "Protocol");
  await tabBecomes(cdp, "Protocol");
  await waitFor(() => cdp.eval(`!!document.querySelector(".decoded__na, .decoded__protoline")`), {
    what: "the Protocol tab's verdict",
  });
  const emptyProto = await cdp.eval(
    `JSON.stringify({
       note: document.querySelector(".decoded__na")?.textContent.trim() ?? null,
       lines: document.querySelectorAll(".decoded__protoline").length,
     })`,
  ).then(JSON.parse);
  check(
    "an experiment with no protocol shows no protocol, not an invented default",
    emptyProto.lines === 0 && /No protocol yet/.test(emptyProto.note ?? ""),
    JSON.stringify(emptyProto),
  );

  // "new protocol" writes the default and lands on the editor, with the name asked for in place —
  // it used to be a "New protocol…" item inside the attach menu that demanded a file name first.
  await clickTab(cdp, "Overview");
  await tabBecomes(cdp, "Overview");
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__part button")`), {
    what: "the Overview parts",
  });
  const clickedNew = await cdp.eval(
    `(() => { const b = [...document.querySelectorAll(".overview__part button")]
        .find((x) => /^new protocol$/i.test(x.textContent.trim()));
       if (b) b.click(); return !!b; })()`,
  );
  check("Overview offers a 'new protocol' button beside 'attach protocol'", clickedNew === true);
  await tabBecomes(cdp, "Protocol");
  await waitFor(() => cdp.eval(`!!document.querySelector(".decoded__prototext")`), {
    what: "the created protocol's text",
  });
  const created = await cdp
    .eval(
      `JSON.stringify({
         lines: [...document.querySelectorAll(".decoded__prototext")].map((l) => l.textContent.trim()),
         nameField: !!document.querySelector(".overview__name"),
         nameMissing: !!document.querySelector(".overview__name.is-missing"),
         required: document.querySelector(".overview__namerequired")?.textContent.trim() ?? null,
       })`,
    )
    .then(JSON.parse);
  check(
    "new protocol lands on the editor holding the default protocol — a header and END, no steps",
    created.lines.join(" ") === "METHOD CALC; HOTLID 105,30; VOLUME 20; END;",
    JSON.stringify(created.lines),
  );
  check(
    "…with its own name asked for, marked missing the way an experiment's is",
    created.nameField && created.nameMissing && created.required === "required",
    JSON.stringify(created),
  );

  cdp.close();
}


/**
 * Type into the Overview header's name field and commit it — a rename, which is also the cheapest
 * way to make a file *modified* (see {@link closeConfirmChecks}). The two halves are separate
 * turns on purpose: the field commits on blur from the *committed* draft state, so blurring in the
 * same tick as the input event would read the value React hasn't applied yet — which real typing
 * never does.
 */
async function setExperimentName(cdp, value) {
  // A run that has already happened shows its name as a heading, not a field — changing it takes a
  // click on the edit button first (see `ExperimentHeader`, and `apps/web/ARCHITECTURE.md`'s
  // "Editing what has already happened"). A pending experiment's field is already live, so this is a
  // no-op there. Doing what a user does rather than reaching past the gate is the point: if the gate
  // ever stops opening, these checks should fail.
  await cdp.eval(
    `(() => { if (!document.querySelector(".overview__name"))
        document.querySelector(".overview__nameeditbtn")?.click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__name")`), {
    what: "the name field to open",
  });
  await cdp.eval(
    // `focus()` first because the commit is on blur, and blurring an element that was never
    // focused fires nothing at all — the field would keep the text and store none of it.
    `(() => { const el = document.querySelector(".overview__name");
       el.focus();
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  // The field is controlled, so the typed text is only really *in* the app once React has rendered
  // it back — blurring before that commits whatever the previous render held.
  await waitFor(
    async () =>
      (await cdp.eval(`document.querySelector(".overview__name")?.value ?? null`)) === value,
    { what: `the name field to read ${JSON.stringify(value)}` },
  );
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
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__filename-input")`), {
    what: "the Filename field to open",
  });
  await cdp.eval(
    `(() => { const el = document.querySelector(".overview__filename-input");
       el.focus();
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  // Controlled field, same as {@link setExperimentName}: wait for the render, not for a guess.
  await waitFor(
    async () =>
      (await cdp.eval(`document.querySelector(".overview__filename-input")?.value ?? null`)) ===
      value,
    { what: `the Filename field to read ${JSON.stringify(value)}` },
  );
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
      `JSON.stringify(Object.fromEntries([...document.querySelectorAll('.viewbar [role="tab"]')]
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
             // Either state of the headline: the live field, or the heading a run that has
             // already happened shows instead -- see setExperimentName.
             name:
               document.querySelector(".overview__name")?.value ??
               document.querySelector(".overview__nametext")?.textContent.trim() ??
               null,
             when: info["Run date"] ?? null,
             file: info["Filename"] ?? null,
             chip: document.querySelector(".filechip__name")?.textContent ?? null,
             chipDate: document.querySelector(".filechip__date")?.textContent ?? null,
           };
         })())`,
      )
      .then(JSON.parse);

  // A run that has happened shows its name as a *heading*, not a permanently-live text field. The
  // field used to sit there open on every finished run, one stray keystroke from rewriting the
  // archive of a run from weeks ago; correcting a typo is legitimate, so the answer is a gate rather
  // than a refusal. See ARCHITECTURE's "Editing what has already happened" for the general rule.
  const gate = await cdp
    .eval(
      `JSON.stringify({
         liveField: !!document.querySelector(".overview__name"),
         heading: document.querySelector(".overview__nametext")?.textContent.trim() ?? null,
         editBtn: !!document.querySelector(".overview__nameeditbtn"),
         btnHidden: (() => {
           const b = document.querySelector(".overview__nameeditbtn");
           return b ? getComputedStyle(b).opacity === "0" : null;
         })(),
       })`,
    )
    .then(JSON.parse);
  check(
    "a run that has happened shows its name as a heading, not an open text field",
    gate.liveField === false && !!gate.heading && gate.editBtn,
    JSON.stringify(gate),
  );
  // Never hover-only: hover cannot be discovered by someone who doesn't know the control is there,
  // and does not exist at all on a touch screen.
  check(
    "…with its edit button always drawn rather than appearing on hover",
    gate.btnHidden === false,
    JSON.stringify(gate),
  );
  await cdp.eval(`document.querySelector(".overview__nameeditbtn").click()`);
  check(
    "…and the button is what opens the field",
    (await waitValue(
      () => cdp.eval(`!!document.querySelector(".overview__name")`),
      (v) => v === true,
    )) === true,
  );
  await cdp.eval(`document.querySelector(".overview__name").blur()`);

  const first = await waitValue(headline, (h) => h.name !== null);
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

  // The archive rewrite is rate-limited (`analysisPersist.ts`, a 60 s window). Rather than bet on
  // this being the first edit — the one the limiter writes immediately — hide the page, which is
  // what makes a real backgrounded tab durable, and flush whatever is pending.
  await flushWrites(cdp);
  // Started, not awaited (see `flushWrites`) — this is the write landing, not the rate
  // limit expiring.
  await sleep(200);
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
  // `ZpcrStore.renameFile` writes the catalog asynchronously, and reloading before it lands would
  // blame the app for the test's own race. The record under the new name is the observable.
  await waitFor(async () => (await catalogNames(cdp)).includes(renamedName), {
    what: "the renamed file's catalog record",
  });
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
    raw.fname === "biomeme-2024-01-17.bmrun" &&
      raw.label.includes("JSON") &&
      raw.list === 0 &&
      /"id"\s*:/.test(raw.body),
    JSON.stringify(raw),
  );

  // The view bar is static: the same nine tabs whatever the file is, with the ones this file
  // has no answer for *disabled* rather than removed (`ViewBar`'s `enabled` prop). Only a
  // browser can show this — it is a claim about two different files' headers being the same
  // shape, and the failure it guards against (tabs appearing and disappearing under the pointer
  // as the selection moves) is invisible to any single-file check.
  const strip = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll('.viewbar [role="tab"]')]
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
 * Open files, the one selection, and what closing a file actually does.
 *
 * Every claim here is invisible to a screenshot and to Vitest alike, because each is about what
 * survives a state change no single render shows:
 *
 * - **closing a file removes it**, records and all: its catalog row is gone from IndexedDB before
 *   the click is over, and a reload does not bring it back. There is no "in storage but not open"
 *   state left to get wrong;
 * - with nothing selected — a `#file=` naming a file this browser doesn't have, which is the one
 *   way to reach that state while files are open — the view bar disables **every** file view and
 *   keeps Files, while the logo and the load button stay live;
 * - a reload comes back holding exactly what was open, described from the files themselves rather
 *   than from anything cached about them.
 */
async function openFilesChecks(chrome, origin) {
  console.log("\nopen files and the selection");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });

  const strip = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll('.viewbar [role="tab"]')]
           .map((b) => ({ label: b.textContent.trim(), off: b.disabled })))`,
      )
      .then(JSON.parse);
  const chips = () => cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  const row = () =>
    cdp
      .eval(
        `(() => { const r = document.querySelector(".filesview__row");
           if (!r) return "null";
           const tds = [...r.querySelectorAll("td")].map((td) => td.textContent.trim());
           return JSON.stringify({ cells: tds }); })()`,
      )
      .then((v) => (v === "null" ? null : JSON.parse(v)));

  // The table describes the file from the decoded file itself — there is no cached summary any
  // more, so a row saying what the run is *is* the app reading the run it is holding.
  await clickTab(cdp, "Files");
  await waitFor(async () => !!(await row()), { what: "the open file's row" });
  const listed = await row();
  check(
    "an open file's row describes the run, live from the file the app is holding",
    listed.cells.some((c) => /S183/.test(c)) && listed.cells.some((c) => /^\d+$/.test(c)),
    JSON.stringify(listed),
  );

  // "Nothing selected" while files are open: a `#file=` naming a file this browser doesn't have.
  // The app says so rather than substituting another file, and the strip has to handle it.
  //
  // Via `about:blank`, because the page is already on this origin and a bare `Page.navigate` to a
  // different fragment of the same URL is a same-document navigation — the hash listener would see
  // a name it doesn't know and leave the selection exactly where it was. The claim is about how the
  // app *starts up* on such a link.
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: `${origin}#file=nosuchfile.zpcr&view=overview` });
  await waitFor(() => cdp.eval(`!!document.querySelector(".app__noselection")`), {
    what: "the no-selection state",
  });
  const empty = await strip();
  check(
    "with nothing selected every file view is disabled, and only Files and Instrument are left",
    empty.filter((t) => !t.off).map((t) => t.label).join(",") === "Files,Instrument",
    JSON.stringify(empty.filter((t) => !t.off).map((t) => t.label)),
  );
  const chrome_ = await cdp.eval(
    `JSON.stringify({
       logo: !!document.querySelector(".app__logo") && !document.querySelector(".app__logo").disabled,
       load: !!document.querySelector('.dropzone input[type="file"]'),
       says: document.querySelector(".app__noselection")?.textContent.trim() || "",
       chips: document.querySelectorAll(".filebar .filechip").length,
     })`,
  ).then(JSON.parse);
  check(
    "…while the About link, the load button and the file's own chip stay live",
    chrome_.logo && chrome_.load && chrome_.chips === 1 && /No file selected/.test(chrome_.says),
    JSON.stringify(chrome_),
  );

  /** Every file IndexedDB still has a catalog row for — what "closed" has to actually mean. */
  const stored = () =>
    cdp
      .eval(
        `new Promise((res) => { const q = indexedDB.open("zpcrweb");
           q.onsuccess = () => { const db = q.result;
             const g = db.transaction("catalog", "readonly").objectStore("catalog").getAllKeys();
             g.onsuccess = () => { res(JSON.stringify(g.result)); db.close(); }; }; })`,
        { awaitPromise: true },
      )
      .then(JSON.parse);

  // Close the one file from the chip's ✕. It is unedited, so one click does it — and with nothing
  // left in the browser at all, the app is back to its welcome screen, which is the truth.
  await cdp.eval(`(() => { document.querySelector(".filebar .filechip__main").click(); })()`);
  await waitFor(async () => (await chips()) === 1, { what: "the file selected again" });
  await cdp.eval(`(() => { document.querySelector(".filebar .filechip__del").click(); })()`);
  await waitFor(async () => (await chips()) === 0, { what: "the chip to go" });
  await waitFor(async () => (await stored()).length === 0, { what: "the record to be deleted" });
  check(
    "closing a file deletes its record then and there, not just its chip",
    (await stored()).length === 0 && (await cdp.eval(`!!document.querySelector(".app--empty")`)) === true,
    JSON.stringify(await stored()),
  );

  // And a reload proves it: nothing came back, because there was nothing left to come back.
  await cdp.eval(`window.location.reload()`);
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  // Nothing was left open, so the app comes back on the welcome screen. Waiting for that is what
  // says hydration has finished — without it the "no chips" below is just an early read.
  await waitFor(() => cdp.eval(`!!document.querySelector(".app--empty")`), {
    what: "the welcome screen after the reload",
  });
  check(
    "…so a reload comes back with nothing, rather than re-listing what was closed",
    (await chips()) === 0 && (await stored()).length === 0,
    JSON.stringify({ chips: await chips(), stored: await stored() }),
  );

  // The other half of the same property: a file that *is* open comes back after a reload, selected
  // and drawn, without being re-opened by hand.
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip again" });
  // The catalog write is asynchronous, and reloading before it lands is what this check would
  // otherwise blame on the app.
  await flushWrites(cdp);
  // Started, not awaited (see `flushWrites`) — this is the write landing, not the rate
  // limit expiring.
  await sleep(200);
  await cdp.eval(`window.location.reload()`);
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  await waitFor(async () => (await chips()) === 1, { what: "the open file after a reload" });
  const reopened = await strip();
  check(
    "a session reopens holding what it was left holding, with the file views back",
    reopened.filter((t) => !t.off).length > 1,
    JSON.stringify(reopened.filter((t) => !t.off).map((t) => t.label)),
  );

  // About is file-independent, so it survives a selection change — which means picking a chip from
  // it would otherwise leave you reading About with a file freshly selected behind it, and look
  // like the click did nothing. `App.tsx`'s `selectFile` sends that click to Overview.
  await cdp.eval(`window.location.hash = "view=about", undefined`);
  await waitFor(() => cdp.eval(`!!document.querySelector(".about")`), { what: "the About view" });
  await cdp.eval(
    `(() => { document.querySelector(".filebar .filechip__main").click(); })()`,
  );
  const landed = await tabBecomes(cdp, "Overview");
  check("picking a file chip from About leaves it for that file's Overview", landed === "Overview", landed);

  // Leave storage empty for the checks that follow.
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector(".ftbl__del")`), { what: "the row's ✕" });
  await cdp.eval(`(() => { document.querySelector(".ftbl__del").click(); })()`);
  await waitFor(() => cdp.eval(`!document.querySelector(".ftbl__del")`), {
    what: "storage to be left empty",
  });
  cdp.close();
}

/**
 * Closing a file, and the second click an edited one costs.
 *
 * Closing is the only way a file leaves the app now: bytes out of memory and records out of
 * IndexedDB together. One control in two places — the chip's ✕ and the table row's ✕, both
 * `CloseFileButton.tsx` — so the two must behave identically, which is half of what this checks.
 * The other half is the confirmation: a file whose edits exist nowhere else arms first (a red waste
 * bin) and takes a second click, and downloading it puts it back to one.
 *
 * All of it is state a screenshot can't judge: whether the first click on an armed ✕ really didn't
 * close, whether closing really emptied IndexedDB (a row coming back after a reload would mean it
 * hadn't), and whether the modified flag outlived a reload — it must, since the stale copy is the
 * one on disk.
 */
async function closeConfirmChecks(chrome, origin) {
  console.log("\nclose confirmation");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip" });

  const chips = () => cdp.eval(`document.querySelectorAll(".filebar .filechip").length`);
  const openTable = () => clickTab(cdp, "Files");
  const tableRows = () => cdp.eval(`document.querySelectorAll(".filesview__row").length`);
  const clickTableClose = () =>
    cdp.eval(`(() => { document.querySelector(".ftbl__del").click(); })()`);
  const clickChipClose = () =>
    cdp.eval(`(() => { document.querySelector(".filebar .filechip__del").click(); })()`);
  const tableDel = () =>
    cdp.eval(
      `(() => { const btn = document.querySelector(".ftbl__del");
         if (!btn) return "null";
         return JSON.stringify({ armed: btn.classList.contains("is-armed") }); })()`,
    ).then((v) => (v === "null" ? null : JSON.parse(v)));
  /** The chip's own state: the modified dot, and whether its ✕ has armed into a waste bin. */
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

  // An unedited file closes on one click, from the table's ✕ — nothing is at risk, since the copy
  // it came from is still on the user's disk.
  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the file's table row" });
  await clickTableClose();
  await waitFor(async () => (await tableRows()) === 0, { what: "the unedited file to close" });
  check("an unedited file's ✕ closes it on the first click", (await tableRows()) === 0);
  check("…and takes its chip with it", (await chips()) === 0);

  // …and it is really gone from storage, not merely off the bar.
  await cdp.eval(`window.location.reload()`);
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  // With the last file closed the app comes back on the welcome screen, which has no view bar and
  // so no Files tab to open. This used to ask for one anyway and pass on the table it never
  // opened being empty; the empty state itself is the stronger claim, and the one being made.
  await waitFor(() => cdp.eval(`!!document.querySelector(".app--empty")`), {
    what: "the welcome screen after the reload",
  });
  check("…and does not come back after a reload", (await tableRows()) === 0);

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
  await flushWrites(cdp);
  // Started, not awaited (see `flushWrites`) — this is the write landing, not the rate
  // limit expiring.
  await sleep(200);
  await cdp.send("Page.navigate", { url: `${origin}#file=${EXAMPLE}&view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(async () => (await chip())?.modified === true, { what: "the flag after a reload" });
  check("the modified state survives a reload", (await chip()).modified === true);

  // The chip's ✕ on an edited file arms rather than closing — the same rule the table row follows,
  // from the same component.
  await clickChipClose();
  const armedChip = await chip();
  check(
    "an edited file's chip ✕ arms into a waste bin instead of closing",
    armedChip !== null && armedChip.bin === true && (await chips()) === 1,
    JSON.stringify(armedChip),
  );
  await clickChipClose();
  await waitFor(async () => (await chips()) === 0, { what: "the confirmed close" });
  check("…and the second click closes it", (await chips()) === 0);

  // The same two-stage behaviour in the table, and then a download to prove it is the *edits* that
  // ask twice rather than the row.
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .zpcr chip once more" });
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");
  await setExperimentName(cdp, "Saved RVP");
  await waitFor(async () => (await chip()).modified === true, { what: "the modified flag" });
  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the edited file's table row" });
  await clickTableClose();
  const armed = await tableDel();
  await waitFor(async () => (await tableRows()) === 1, { what: "the row to still be there" });
  check(
    "the first click on an edited file's table ✕ arms it instead of closing",
    armed.armed && (await tableRows()) === 1,
    JSON.stringify(armed),
  );

  // Download it: the edits are on disk now, so the ✕ stops asking.
  //
  // `clickTab` rather than a hash write plus `tabBecomes`: the latter *reports* where the view
  // settled instead of insisting, so a hash write that lost a race left the page on Files and the
  // wait below then timed out on a button that was never going to appear — the intermittent
  // "timed out waiting for Overview's download button". `clickTab` presses the tab and confirms
  // it took.
  await clickTab(cdp, "Overview");
  // The tab is current before its toolbar is painted, so waiting for the button is the difference
  // between this passing and throwing on a null.
  await waitFor(
    () => cdp.eval(`!!document.querySelector(".overview__toolbar .overview__downloadbtn")`),
    { what: "Overview's download button" },
  );
  await cdp.eval(`(() => { document.querySelector(".overview__toolbar .overview__downloadbtn").click(); })()`);
  await waitFor(async () => (await chip()).modified === false, { what: "the flag to clear" });
  check("downloading the file clears the modified state", (await chip()).modified === false);
  await openTable();
  await waitFor(async () => (await tableRows()) === 1, { what: "the saved file's table row" });
  await clickTableClose();
  await waitFor(async () => (await tableRows()) === 0, { what: "the saved file to close" });
  check("…so its ✕ closes it on one click again", (await tableRows()) === 0);
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
  // Edit is the pencil icon now (matching Overview's rename buttons), so it has no text to match on
  // — it is found by its accessible label, and reports "Edit"/"Done" as its label either way so the
  // checks below still read as the states they are. Done stays a worded button: it is the way out.
  const editBtn = () =>
    cdp.eval(`(() => { const b = [...document.querySelectorAll(".overview__blocktools button")]
        .find((x) => /^(Edit|Done)$/.test(x.textContent.trim()) ||
                     /^Edit this protocol$/.test(x.getAttribute("aria-label") ?? ""));
       if (!b) return "null";
       const label = /^Done$/.test(b.textContent.trim()) ? "Done" : "Edit";
       return JSON.stringify({ label, off: b.disabled, why: b.title }); })()`)
      .then((v) => (v === "null" ? null : JSON.parse(v)));
  const clickButton = (label) =>
    cdp.eval(`(() => { const want = ${JSON.stringify(label)};
       const b = [...document.querySelectorAll(".overview__blocktools button")]
        .find((x) => x.textContent.trim().startsWith(want) ||
                     (want === "Edit" && /^Edit this protocol$/.test(x.getAttribute("aria-label") ?? "")));
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
  await sleep(200); // negative assertion: no form should open, so there is no state to wait for
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
 * The plate editor's page vocabulary, for the two check functions that drive it — a standalone
 * `.plt.csv` ({@link plateEditorChecks}) and a run's own plate ({@link runPlateEditChecks}).
 *
 * It is one editor in both places (`PlateEditor.tsx`), so it gets one set of selectors rather than
 * a copy per caller that can drift out of step with it.
 *
 * Cells are addressed by grid position rather than by a test hook, and the gestures go in as real
 * `mousedown` events with the modifier and button flags set — which is what the selection rules
 * actually read.
 */
function plateEditorPage(cdp) {
  /** One well cell, by row/column — `.plate__grid` has a header row and a header cell per row. */
  const cellExpr = (row, col) =>
    `document.querySelectorAll(".plate__grid tbody tr")[${row}].querySelectorAll("td")[${col}]`;
  /** The panel field or menu with this accessible label. */
  const fieldExpr = (label) =>
    `[...document.querySelectorAll(".plateedit__panel input, .plateedit__panel select")]
       .find((x) => x.getAttribute("aria-label") === ${JSON.stringify(label)})`;
  return {
    /** What a well shows: its sample name and the targets drawn in it. */
    wellText: (row, col) =>
      cdp.eval(`(() => { const td = ${cellExpr(row, col)};
         return JSON.stringify({
           sample: (td.querySelector(".plate__wellsample") || {}).textContent ?? "",
           targets: [...td.querySelectorAll(".plate__target")].map((t) => t.textContent).filter(Boolean),
           selected: td.classList.contains("is-selected"),
         }); })()`).then(JSON.parse),
    selectedCount: () => cdp.eval(`document.querySelectorAll(".plate__well.is-selected").length`),
    panelTitle: () =>
      cdp.eval(`((document.querySelector(".plateedit__panelhead .decoded__h") || {}).textContent || "").trim()`),
    editBtn: () =>
      cdp.eval(`(() => { const b = [...document.querySelectorAll(".plateview__toolbar button")]
          .find((x) => /^Done$/.test(x.textContent.trim()) ||
                       /^Edit this plate$/.test(x.getAttribute("aria-label") ?? ""));
         return b ? (/^Done$/.test(b.textContent.trim()) ? "Done" : "Edit") : "none"; })()`),
    clickEdit: () =>
      cdp.eval(`(() => { const b = [...document.querySelectorAll(".plateview__toolbar button")]
          .find((x) => /^Done$/.test(x.textContent.trim()) ||
                       /^Edit this plate$/.test(x.getAttribute("aria-label") ?? ""));
         if (b) b.click(); return !!b; })()`),
    /** A click on a well, with the modifiers a spreadsheet reads and the button a mouse has. */
    clickCell: (row, col, mods = {}) =>
      cdp.eval(`(() => { ${cellExpr(row, col)}.dispatchEvent(new MouseEvent("mousedown",
         { bubbles: true, metaKey: ${!!mods.meta}, shiftKey: ${!!mods.shift},
           button: ${mods.button ?? 0}, buttons: ${mods.button === 2 ? 2 : 1} })); return true; })()`),
    /**
     * The mouse arriving over a cell mid-drag — what extends a sweep.
     *
     * Both events, because React derives `onMouseEnter` from the delegated `mouseover` while the
     * cell's own listener wants the `mouseenter`; sending one of the two is a silent no-op
     * depending on which side is looking, and the sweep then never grows.
     */
    enterCell: (row, col) =>
      cdp.eval(`(() => { const td = ${cellExpr(row, col)};
         td.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, buttons: 1 }));
         td.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, buttons: 1 }));
         return true; })()`),
    /** A right-click on the grid, which is what opens the context menu over it. */
    contextMenu: () =>
      cdp.eval(`(() => { document.querySelector(".plate__grid")
         .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })); return true; })()`),
    clickColumnHead: (col) =>
      cdp.eval(`(() => { document.querySelectorAll(".plate__grid thead th")[${col + 1}]
         .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return true; })()`),
    clickRowHead: (row) =>
      cdp.eval(`(() => { document.querySelectorAll(".plate__grid tbody tr")[${row}].querySelector("th")
         .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return true; })()`),
    /** Type into (or choose in) one of the panel's fields, by its accessible label. */
    setPanel: (label, value) =>
      cdp.eval(`(() => {
        const el = ${fieldExpr(label)};
        if (!el) return false;
        const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true; })()`),
    /** What a panel `<select>` offers: its tag and the options' text, for the closed-list fields. */
    panelOptions: (label) =>
      cdp.eval(`(() => { const el = ${fieldExpr(label)};
         return JSON.stringify({ tag: el ? el.tagName : "none",
                                 options: el && el.options ? [...el.options].map((o) => o.text) : [],
                                 value: el ? el.value : null }); })()`).then(JSON.parse),
    /** Put the caret in a panel field — the state a user is in after typing a sample name. */
    focusPanelField: (label) =>
      cdp.eval(`(() => { const el = ${fieldExpr(label)}; if (!el) return false; el.focus(); return true; })()`),
    /**
     * A keystroke, optionally as one of Chrome's own editing `commands`.
     *
     * Cmd-C and Cmd-V need the command: a key event alone is just a key event, and it is Chrome's
     * copy/paste command that produces the `copy`/`paste` event and touches the system clipboard.
     * Dispatching that command is what makes this the real gesture rather than a `ClipboardEvent`
     * the test synthesized — a distinction with teeth, since an event the test aims at `window`
     * arrives whether or not the app could ever have received the real one. It could not: the
     * editor stands aside for a focused text field, and every one of these keystrokes was being
     * swallowed by the panel box the user had last typed in.
     */
    key: async (k, { code, vk, mods = 0, commands } = {}) => {
      await cdp.send("Input.dispatchKeyEvent", {
        type: commands ? "rawKeyDown" : "keyDown",
        key: k, code: code ?? k, windowsVirtualKeyCode: vk ?? 0, modifiers: mods,
        ...(commands ? { commands } : {}),
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: k, code: code ?? k, windowsVirtualKeyCode: vk ?? 0, modifiers: mods,
      });
    },
  };
}

/**
 * The Plate view's editor for a `.plt.csv` (`components/plate/PlateEditor.tsx`).
 *
 * All of it is interaction, and none of it is visible in a screenshot: which wells a gesture
 * selects, that an edit lands on every selected well and only on the field that was typed in, that
 * the clipboard carries a block of wells, and that the result is in the *file* rather than in the
 * view. The plate model and the clipboard format are core's and are asserted there
 * (`test/plateEdit.test.ts`, `test/plateClipboard.test.ts`). Selectors and gestures come from
 * {@link plateEditorPage}.
 */
async function plateEditorChecks(chrome, origin) {
  console.log("\nplate editor");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples/S183-S185-RVP.plt.csv"));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the .plt.csv chip" });
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");

  const {
    wellText, selectedCount, panelTitle, editBtn, clickEdit, clickCell, enterCell, contextMenu,
    clickColumnHead, clickRowHead, setPanel, panelOptions, focusPanelField, key,
  } = plateEditorPage(cdp);

  check("a .plt.csv's Plate tab offers an Edit button", (await editBtn()) === "Edit", await editBtn());
  check("…and no well is selectable before it is pressed", (await selectedCount()) === 0);

  await clickEdit();
  await waitFor(async () => (await editBtn()) === "Done", { what: "edit mode" });
  check("Edit turns into Done and opens the details panel", /No wells selected/.test(await panelTitle()));

  // A4 is a loaded well of this plate (three targets, one sample) — clicking it selects exactly it.
  await clickCell(0, 3);
  await waitFor(async () => (await selectedCount()) === 1, { what: "one selected well" });
  check("clicking a well selects it alone, and the panel says which", /Well A4/.test(await panelTitle()));

  // The column gesture, and the reason the panel edits one field at a time: setting the sample for
  // a whole column must not disturb the targets already in it.
  const beforeTargets = (await wellText(0, 3)).targets;
  await clickColumnHead(3);
  await waitFor(async () => (await selectedCount()) === 8, { what: "a selected column" });
  check("clicking a column number selects the whole column", (await panelTitle()).startsWith("8 wells"), await panelTitle());

  await setPanel("Sample name for the selected wells", "Bulk edit");
  await waitFor(async () => (await wellText(0, 3)).sample === "Bulk edit", { what: "the bulk edit" });
  const a4 = await wellText(0, 3);
  const h4 = await wellText(7, 3);
  check(
    "editing the sample applies to every selected well and leaves their targets alone",
    a4.sample === "Bulk edit" && h4.sample === "Bulk edit" &&
      JSON.stringify(a4.targets) === JSON.stringify(beforeTargets),
    JSON.stringify({ a4, h4, beforeTargets }),
  );

  // The two closed lists in the panel. Both are menus rather than text boxes because what goes in
  // them has to match something outside the app — a vessel a `.Dcal` names, a dye every other
  // plate spells the same way — and a typo in either is a value that silently matches nothing.
  const vessel = await panelOptions("Vessel for the selected wells");
  check(
    "Vessel is a menu of the two plates a run is calibrated for",
    vessel.tag === "SELECT" && JSON.stringify(vessel.options) === JSON.stringify(["unstated", "BR Clear", "BR White"]),
    JSON.stringify(vessel),
  );
  const dyes = await panelOptions("Add a dye to the plate");
  check(
    "adding a dye offers the dyes this app has colours for, and a door out to any other name",
    dyes.tag === "SELECT" && dyes.options.includes("Quasar 705") && dyes.options.includes("Other…") &&
      !dyes.options.includes("FAM"), // already on this plate, so not offered again
    JSON.stringify(dyes),
  );
  await setPanel("Add a dye to the plate", "Quasar 705");
  await waitFor(
    () => cdp.eval(`[...document.querySelectorAll(".plate__fluors--inline .plate__chip")]
       .some((c) => /Quasar 705/.test(c.textContent))`),
    { what: "the dye picked from the menu" },
  );
  check("…and picking one adds it to the plate, with no second button to press", true);

  // Cmd-click adds one well to the selection; Shift-click extends a rectangle from the anchor.
  await clickCell(0, 0, { meta: true });
  await waitFor(async () => (await selectedCount()) === 9, { what: "the added well" });
  check("Cmd-click adds a well to the selection", (await selectedCount()) === 9);
  await clickCell(0, 0);
  // The anchor a Shift-click extends from is React state, so it has to have landed first — a
  // shift-click dispatched in the same tick would extend from the *previous* anchor.
  await waitFor(async () => /Well A1/.test(await panelTitle()), { what: "the new anchor" });
  await clickCell(2, 2, { shift: true });
  await waitFor(async () => (await selectedCount()) === 9, { what: "the extended rectangle" });
  check("Shift-click selects the rectangle from the anchor", (await selectedCount()) === 9);

  // A right-click ends a sweep. The context menu swallows the `mouseup` that would otherwise end
  // it, so without a `contextmenu` listener the drag stayed armed: the menu closed and the next
  // move of an unpressed mouse across the grid went on painting a rectangle.
  await clickCell(0, 0);
  await enterCell(0, 1);
  await waitFor(async () => (await selectedCount()) === 2, { what: "a two-well sweep" });
  await contextMenu();
  await enterCell(0, 5);
  // Negative: the selection must *not* grow, so there is no state change to wait for.
  await sleep(250);
  const afterMenu = await selectedCount();
  check("a right-click ends a drag instead of leaving it armed", afterMenu === 2, `selected ${afterMenu}`);

  // …and a right-click on a well doesn't start one, or move the selection out from under the menu
  // the user is about to read.
  await clickCell(0, 0);
  await waitFor(async () => /Well A1/.test(await panelTitle()), { what: "A1 selected alone" });
  await clickCell(3, 3, { button: 2 });
  // Negative, as above: the selection must stay where the left-click put it.
  await sleep(250);
  const afterRight = await panelTitle();
  check("a right-click on a well leaves the selection alone", /Well A1/.test(afterRight), afterRight);

  // The clipboard carries whole wells: copy A4, paste it onto A1, and A1 becomes A4.
  //
  // Done from the state a user is actually in — having just typed in the panel, which is what the
  // `setPanel` above leaves focused. The editor's clipboard and keyboard handlers stand aside for
  // a focused text field, so until the grid started taking focus on a click (`PlateViewer`'s
  // `gridRef`) every one of these keystrokes was swallowed by whichever box was last typed in, and
  // Cmd-C, Cmd-V, Delete and the arrows did nothing for the rest of the session.
  await focusPanelField("Sample name for the selected wells");
  await clickCell(0, 3);
  await waitFor(async () => /Well A4/.test(await panelTitle()), { what: "A4 selected alone" });
  check(
    "clicking a well takes focus off the panel field, so the keyboard reaches the plate",
    (await cdp.eval(`document.activeElement.tagName`)) === "TABLE",
    await cdp.eval(`document.activeElement.tagName + "/" + (document.activeElement.getAttribute("aria-label") ?? "")`),
  );

  await key("c", { code: "KeyC", vk: 67, mods: 4, commands: ["copy"] });
  await clickCell(0, 0);
  await waitFor(async () => /Well A1/.test(await panelTitle()), { what: "A1 selected alone" });
  await key("v", { code: "KeyV", vk: 86, mods: 4, commands: ["paste"] });
  await waitFor(async () => (await wellText(0, 0)).sample === "Bulk edit", { what: "the pasted well" });
  const pasted = await wellText(0, 0);
  check(
    "Cmd-C and Cmd-V carry a whole well, targets and all",
    pasted.sample === "Bulk edit" && JSON.stringify(pasted.targets) === JSON.stringify(a4.targets),
    JSON.stringify({ pasted, a4 }),
  );

  // Delete empties the selection; Cmd-Z puts it back — the same history the buttons walk.
  await key("Delete", { code: "Delete", vk: 46 });
  await waitFor(async () => (await wellText(0, 0)).sample === "", { what: "the cleared well" });
  check("Delete empties the selected wells", (await wellText(0, 0)).targets.length === 0);
  await key("z", { code: "KeyZ", vk: 90, mods: 4 });
  await waitFor(async () => (await wellText(0, 0)).sample === "Bulk edit", { what: "the undo" });
  check("Cmd-Z undoes it", (await wellText(0, 0)).sample === "Bulk edit");

  // A row header selects its 12 wells, and Cmd-A the whole plate — the two remaining gestures.
  await clickRowHead(1);
  await waitFor(async () => (await selectedCount()) === 12, { what: "a selected row" });
  check("clicking a row letter selects the whole row", (await selectedCount()) === 12);
  await key("a", { code: "KeyA", vk: 65, mods: 4 });
  await waitFor(async () => (await selectedCount()) === 96, { what: "the whole plate" });
  check("Cmd-A selects every well", (await selectedCount()) === 96);
  await key("Escape", { code: "Escape", vk: 27 });
  await waitFor(async () => (await selectedCount()) === 0, { what: "the cleared selection" });

  // Leaving the view saves what was edited and drops edit mode — the edits are already in the
  // file, so the round trip through another tab is also the check that they were written.
  await clickTab(cdp, "Raw");
  await tabBecomes(cdp, "Raw");
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");
  check("changing the view leaves edit mode", (await editBtn()) === "Edit", await editBtn());

  await cdp.send("Page.reload", {});
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the chip after reload" });
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");
  check(
    "edits are written to the file as they're made, with no Done required",
    (await wellText(0, 3)).sample === "Bulk edit",
    JSON.stringify(await wellText(0, 3)),
  );

  // A `.pltd` is read-only here: this app has no `.pltd` writer, so there is nowhere to save an
  // edit to one, and it gets the same grid with no pencil rather than an editor that can't.
  await loadFile(cdp, join(REPO, "samples/QuickPlate_96 wells_All Channels.pltd"));
  await waitFor(() => chipPresent(cdp, "QuickPlate"), { what: "the .pltd chip" });
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");
  check("a .pltd gets no editor, having no writer to save through", (await editBtn()) === "none", await editBtn());
  cdp.close();
}

/**
 * The same editor on a **run's own plate** — the `.plt.csv` inside a `.zpcr`'s archive, edited in
 * place from the Plates tab (`views/PlatesView.tsx`, the store's `setRunPlateText`).
 *
 * What is worth checking here is not the editing — that is {@link plateEditorChecks}, and it is one
 * component either way — but where the result *goes*. A run's plate is an archive entry, so an edit
 * has to survive being re-derived from the run (`Zpcr.plates()` re-parses the archive on every
 * change) and has to reach IndexedDB, and neither is visible on screen. It also has to leave the
 * rest of the run alone: the entry is rewritten through core's `attachPlate`, which is the same
 * call "replace this run's plate" makes, and a run that came back missing its protocol or its
 * plate reads would look perfectly fine in the grid.
 */
async function runPlateEditChecks(chrome, origin) {
  console.log("\nediting a run's own plate");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  await loadFile(cdp, join(REPO, "samples/20260720_FirstQualification.zpcr"));
  await waitFor(() => chipPresent(cdp, "FirstQualification"), { what: "the run's chip" });
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");

  const { wellText, panelTitle, editBtn, clickEdit, clickCell, setPanel } = plateEditorPage(cdp);

  check("a run whose plate is a .plt.csv offers an Edit button", (await editBtn()) === "Edit", await editBtn());
  await clickEdit();
  await waitFor(async () => (await editBtn()) === "Done", { what: "edit mode on the run's plate" });

  // B3 is a loaded well of this run's plate.
  await clickCell(1, 2);
  await waitFor(async () => /Well B3/.test(await panelTitle()), { what: "B3 selected" });
  await setPanel("Sample name for the selected wells", "Edited in run");
  await waitFor(async () => (await wellText(1, 2)).sample === "Edited in run", { what: "the run plate edit" });
  check("editing a run's plate changes the well", (await wellText(1, 2)).sample === "Edited in run");

  // The edit is in the archive, not just in the view: a reload reads the run back out of
  // IndexedDB, and the rest of the run has to still be there with it.
  await flushWrites(cdp);
  await cdp.send("Page.reload", {});
  await waitFor(() => chipPresent(cdp, "FirstQualification"), { what: "the run's chip after reload" });
  await clickTab(cdp, "Plates");
  await tabBecomes(cdp, "Plates");
  check(
    "…and the edit is in the run's archive, surviving a reload",
    (await wellText(1, 2)).sample === "Edited in run",
    JSON.stringify(await wellText(1, 2)),
  );

  // Rewriting the plate entry must not have taken anything else out of the archive with it.
  await clickTab(cdp, "Raw");
  await tabBecomes(cdp, "Raw");
  const entries = await cdp.eval(
    `JSON.stringify([...document.querySelectorAll(".raw__item")].map((b) => b.textContent.trim()))`,
  ).then(JSON.parse);
  check(
    "…and the run still has its protocol and its plate reads",
    entries.some((e) => /ProtocolRunDefinition/.test(e)) &&
      entries.filter((e) => /\.Plateread$/.test(e)).length > 0 &&
      entries.filter((e) => /\.plt\.csv$/.test(e)).length === 1,
    JSON.stringify(entries.slice(0, 40)),
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
  // A `.prcl.txt` rather than a run, because for a run this button means something else now: a run's
  // Clone makes a new *experiment* from its protocol and plate (checked in the instrument block),
  // since a byte-for-byte second copy of a finished run's results is never the thing wanted. The
  // plain file copy this exercises is what every other kind still gets.
  mkdirSync(dirname(PRCL_TXT), { recursive: true });
  writeFileSync(PRCL_TXT, PRCL_TXT_BODY);
  await loadFile(cdp, PRCL_TXT);
  await waitFor(() => chipPresent(cdp, "Gradient"), { what: "the .prcl.txt chip" });
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

  const base = "Gradient";
  const ext = ".prcl.txt";
  const clone = () => cdp.eval(`document.querySelector(".overview__clonebtn").click()`);

  await clone();
  await waitFor(async () => /\(2\)/.test((await state()).file ?? ""), { what: "the cloned file's Overview" });
  const first = await state();
  check(
    "Clone copies the file under a (2) name and opens the copy",
    first.file === `${base} (2)${ext}`,
    JSON.stringify(first),
  );
  check(
    "…in edit mode, with the filename field focused and ready to type over",
    first.editing && first.focused,
    JSON.stringify(first),
  );
  check(
    "…beside the original rather than replacing it",
    first.chips.length === 2 && first.chips.some((c) => c === base),
    JSON.stringify(first),
  );

  // Cloning the clone: the index increments rather than a second one being appended.
  await clone();
  await waitFor(async () => /\(3\)/.test((await state()).file ?? ""), { what: "the second clone" });
  const second = await state();
  check(
    "cloning a clone increments the index instead of nesting another one",
    second.file === `${base} (3)${ext}` && second.chips.length === 3,
    JSON.stringify(second),
  );

  // The copy is a real loaded file, not a view-level fiction: it has to still be there after a
  // reload, since nothing but IndexedDB holds it (it was never on disk).
  await cdp.eval(`document.querySelector(".overview__filename-input").blur()`);
  // The blur is what commits the name; the catalog record under it is what the reload below will
  // go looking for, so wait for that rather than for an interval.
  await waitFor(async () => (await catalogNames(cdp)).includes(`${base} (3)${ext}`), {
    what: "the clone's catalog record under its new name",
  });
  await cdp.send("Page.navigate", { url: `${origin}#file=${encodeURIComponent(`${base} (3)${ext}`)}&view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(async () => (await state()).file !== null, { what: "the reloaded clone" });
  const reloaded = await state();
  check(
    "a clone survives a reload — it went into IndexedDB like any loaded file",
    reloaded.file === `${base} (3)${ext}` && reloaded.chips.length === 3,
    JSON.stringify(reloaded),
  );
  cdp.close();
}

/**
 * Every `.zpcr` is stored as its archive entries, one IndexedDB record each, and never as a ZIP —
 * running or finished alike. See `apps/web/src/state/fileContent.ts` for why; this checks the rule
 * actually holds where it can only be seen, in IndexedDB, and that nothing about it reaches the
 * user.
 *
 * The in-progress fixture is a real 3-read run with its `ended` marker deleted: byte for byte what
 * an archive looks like mid-run, which is the state the app can otherwise only reach with an
 * instrument attached.
 */
async function explodedStorageChecks(chrome, origin) {
  console.log("\nentry storage");
  await makeInProgressRun();
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);

  /**
   * Every stored file, as the shape of its content rather than its content. The `content` store
   * holds one record per archive entry, keyed `[name, entry]`, so this groups by the file name —
   * which is also its key in `catalog` (see `state/db.ts`), so there is nothing to join.
   *
   * A plain file is the single `WHOLE_FILE` entry, U+0000; anything else is a `.zpcr`'s entries.
   */
  const records = () =>
    cdp
      .eval(
        `new Promise((res) => { const q = indexedDB.open("zpcrweb");
           q.onsuccess = () => { const db = q.result;
             const g = db.transaction("content", "readonly").objectStore("content").getAll();
             g.onsuccess = () => {
               const byFile = new Map();
               for (const r of g.result) {
                 const v = byFile.get(r.name) ?? { name: r.name, entries: [], bytes: 0 };
                 v.entries.push(r.entry);
                 v.bytes += r.bytes.byteLength;
                 byFile.set(r.name, v);
               }
               res(JSON.stringify([...byFile.values()].map((v) => {
                 const whole = v.entries.length === 1 && v.entries[0] === "\u0000";
                 return { name: v.name, bytes: v.bytes, whole,
                          entries: whole ? null : v.entries.length };
               })));
             }; }; })`,
        { awaitPromise: true },
      )
      .then(JSON.parse);
  const recordFor = async (fragment) =>
    (await records()).find((r) => r.name.includes(fragment)) ?? null;

  // A finished run: nothing more will be appended, so it is kept as the file it came in as.
  await loadFile(cdp, join(REPO, "samples", EXAMPLE));
  await waitFor(() => chipPresent(cdp, "S183"), { what: "the finished run's chip" });
  await waitFor(async () => (await recordFor("S183")) !== null, { what: "its stored record" });
  const finished = await recordFor("S183");
  check(
    "a finished run is stored as its entries too — no ZIP anywhere in the database",
    finished.entries > 30 && !finished.whole,
    JSON.stringify(finished),
  );

  // A run in progress: held open, one record value per archive entry.
  await loadFile(cdp, IN_PROGRESS_ZPCR);
  await waitFor(() => chipPresent(cdp, "Still Running"), { what: "the in-progress chip" });
  await waitFor(async () => (await recordFor("Still_Running")) !== null, { what: "its record" });
  const running = await recordFor("Still_Running");
  check(
    "a run still in progress is stored the same way — every entry its own record",
    running.entries > 30 && !running.whole,
    JSON.stringify(running),
  );

  // …and it is still a run to everything above the store: same tabs, same reads, same state.
  await cdp.eval(`window.location.hash = "view=overview", undefined`);
  await tabBecomes(cdp, "Overview");
  // The file's bytes arrive asynchronously (the loaded set — see `useZpcrStore.loadOne`), and the
  // content-derived tabs only light up once they have, so wait for the run rather than racing it.
  const enabledTabs = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll('.viewbar [role="tab"]')]
           .filter((b) => !b.disabled).map((b) => b.textContent.trim()))`,
      )
      .then(JSON.parse);
  await waitFor(async () => (await enabledTabs()).includes("Curves"), {
    what: "the in-progress run's views",
  });
  const opened = {
    inProgress: await cdp.eval(`!!document.querySelector(".filechip.is-running")`),
    tabs: await enabledTabs(),
  };
  check(
    "…and opens as an ordinary run, with the views its content earns",
    opened.tabs.includes("Curves") && opened.tabs.includes("Plates") && opened.inProgress,
    JSON.stringify(opened),
  );

  // ── Only what changed is written ───────────────────────────────────────────────────────────
  //
  // The claim is that an edit rewrites the one entry it touched and leaves the other ~41 alone.
  // From outside there is no way to watch a write, so instead: poison an entry nobody is about to
  // edit, directly in IndexedDB, then make an edit and read that entry back. If it still holds the
  // sentinel, the write skipped it. Before the delta this check would fail — every entry was
  // re-put on every write, and the poison would have been overwritten with the real bytes.
  const poison = async (file, entry) =>
    cdp.eval(
      `new Promise((res) => { const q = indexedDB.open("zpcrweb");
         q.onsuccess = () => { const db = q.result;
           const s = db.transaction("content", "readwrite").objectStore("content");
           const g = s.get([${JSON.stringify(file)}, ${JSON.stringify(entry)}]);
           g.onsuccess = () => { const r = g.result;
             r.bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
             s.put(r); res(true); }; }; })`,
      { awaitPromise: true },
    );
  const entryNames = async (file) =>
    cdp
      .eval(
        `new Promise((res) => { const q = indexedDB.open("zpcrweb");
           q.onsuccess = () => { const db = q.result;
             const g = db.transaction("content", "readonly").objectStore("content")
               .getAllKeys(IDBKeyRange.bound([${JSON.stringify(file)}], [${JSON.stringify(file)}, []]));
             g.onsuccess = () => res(JSON.stringify(g.result.map((k) => k[1]))); }; })`,
        { awaitPromise: true },
      )
      .then(JSON.parse);
  const entryBytes = async (file, entry) =>
    cdp.eval(
      `new Promise((res) => { const q = indexedDB.open("zpcrweb");
         q.onsuccess = () => { const db = q.result;
           const g = db.transaction("content", "readonly").objectStore("content")
             .get([${JSON.stringify(file)}, ${JSON.stringify(entry)}]);
           g.onsuccess = () => res(g.result ? g.result.bytes.byteLength : -1); }; })`,
      { awaitPromise: true },
    );
  const runFile = (await recordFor("Still_Running")).name;
  // Any calibration entry will do — they are the bulk of the archive and nothing here touches them.
  const untouched = (await entryNames(runFile)).find((n) => n.endsWith(".Dcal"));
  await poison(runFile, untouched);

  // Editing it must not force it back into a ZIP: renaming the experiment rewrites one JSON entry.
  await setExperimentName(cdp, "Still Running Renamed");
  await waitFor(() => chipPresent(cdp, "Still Running Renamed"), { what: "the renamed chip" });
  await flushWrites(cdp);
  // Started, not awaited (see `flushWrites`) — this is the write landing, not the rate
  // limit expiring.
  await sleep(200);
  // Looked up by file name, which a renamed *experiment* doesn't change — the chip's label does.
  const edited = await recordFor("Still_Running");
  check(
    "editing a run in progress leaves it as entries, never re-zipping it",
    edited !== null && edited.entries > 30 && !edited.whole,
    JSON.stringify(edited),
  );
  const survived = await entryBytes(runFile, untouched);
  check(
    "…and rewrites only the entry it touched, leaving the other 41 records alone",
    survived === 4,
    `${untouched}: ${survived} bytes (4 = the sentinel survived, ~31000 = it was rewritten)`,
  );

  // The one thing that has to be true for any of this to be safe: what leaves the browser is a
  // real `.zpcr`. Capture the blob the download builds and look at it.
  const downloaded = await cdp
    .eval(
      `(async () => {
         const real = URL.createObjectURL;
         let blob = null;
         URL.createObjectURL = (b) => { blob = b; return real.call(URL, b); };
         document.querySelector(".overview__toolbar .overview__downloadbtn").click();
         URL.createObjectURL = real;
         if (!blob) return JSON.stringify({ got: false });
         const head = new Uint8Array(await new Response(blob).arrayBuffer());
         return JSON.stringify({
           got: true,
           size: head.length,
           zip: head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04,
         });
       })()`,
      { awaitPromise: true },
    )
    .then(JSON.parse);
  check(
    "downloading one zips it back up — what leaves the browser is an ordinary .zpcr",
    downloaded.got && downloaded.zip && downloaded.size > 10_000,
    JSON.stringify(downloaded),
  );

  // A reload reads the exploded record straight back: still a run, still open, still cheap.
  await cdp.send("Page.navigate", { url: `${origin}#view=overview` });
  await tabBecomes(cdp, "Overview");
  await waitFor(() => chipPresent(cdp, "Still Running Renamed"), { what: "the chip after reload" });
  const afterReload = await recordFor("Still_Running");
  check(
    "an exploded run survives a reload as itself, without being repacked",
    afterReload !== null && afterReload.entries > 30 && !afterReload.whole,
    JSON.stringify(afterReload),
  );

  // A brand-new experiment has not started either, so it is born exploded.
  await cdp.eval(`window.location.hash = "view=about", undefined`);
  await waitFor(
    () =>
      cdp.eval(
        `[...document.querySelectorAll("button")].some((b) => /New experiment/.test(b.textContent))`,
      ),
    { what: "the New experiment button" },
  );
  await cdp.eval(
    `(() => { [...document.querySelectorAll("button")]
        .find((b) => /New experiment/.test(b.textContent)).click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".overview__pending")`), {
    what: "the new experiment's pending banner",
  });
  const pending = await waitValue(
    async () => (await records()).filter((r) => r.entries !== null && r.entries < 5),
    (rs) => rs.length > 0,
  );
  check(
    "a pending experiment is stored exploded too — it hasn't started, so nothing is packed",
    pending.length === 1 && !pending[0].whole && pending[0].entries >= 1,
    JSON.stringify(pending),
  );
  cdp.close();
}

/**
 * Folders on disk: the File System Access API route in (`state/diskFolders.ts`,
 * `state/useDiskTree.ts`, `components/FolderSection.tsx`).
 *
 * **The picker cannot be automated, so it is replaced.** CDP intercepts `showDirectoryPicker`
 * (`Page.setInterceptFileChooserDialog` sees the chooser open) but there is no command that can
 * *fulfil* it with a directory — the call just rejects with `AbortError`. So the test overrides
 * `window.showDirectoryPicker` with one that returns an **origin-private** directory it has filled
 * itself. Everything downstream of the picker is then the real thing: an OPFS handle supports
 * `entries`, `resolve`, `createWritable` and `queryPermission` (which answers `granted`), survives
 * the IndexedDB round-trip the app stores it through, and delivers `FileSystemObserver` records
 * including the delete-then-`errored` sequence the watch has to re-arm from. The override lives
 * here, in the test; no code ships for it.
 *
 * **The fixture never crosses the wire.** The tree is built inside the page by `fetch`ing the
 * example run the app already serves at `/examples/` (a bundled sample — see `lib/samples.ts`), so
 * a 400 kB archive costs nothing in the transcript.
 *
 * What this is really guarding, in order of how quietly it would break:
 *
 * - **The lazy listing.** A closed branch must not have been read. Asserted by counting the
 *   directory reads the page performed, not by looking at the DOM.
 * - **Write-through.** An edit in the app must change the bytes of the real file, which the test
 *   reads back out of OPFS itself.
 * - **The observer re-arm.** Deleting and recreating a watched file — what an external atomic save
 *   looks like — must still refresh. This is the one that fails silently in production and the
 *   reason `rearmWatch` exists.
 * - **No echo loop.** The app's own write must not read itself back forever.
 */
/**
 * The Files view's type chips: one per kind of file the browser is holding, filtering the table to
 * that kind. What is checked is that they are a *filter* — nothing on is the whole catalog, and the
 * count in the footer says which of the two it is — rather than a selection that hides files with
 * no way back.
 */
async function fileTypeFilterChecks(chrome, origin) {
  console.log("\nfolder file-type filter");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  // A file first, because an empty browser gets the welcome screen instead of the view bar. The
  // bundled `samples` folder is the subject: it is a flat directory of a dozen-odd files across
  // every kind the app opens, and it is there on any browser with no folder granted at all.
  await loadFile(cdp, ZPCR);
  await waitFor(() => chipPresent(cdp, "FirstQualification"), { what: "the .zpcr chip" });
  await clickTab(cdp, "Files");

  const FILES = ".folders__pane--files";
  const state = () =>
    cdp
      .eval(
        `JSON.stringify({
           chips: [...document.querySelectorAll(".kindfilter__chip")].map((b) => ({
             text: b.textContent.trim().replace(/\\s+/g, " "),
             on: b.getAttribute("aria-pressed") === "true",
           })),
           files: [...document.querySelectorAll("${FILES} .folders__name")].map((b) => b.textContent.trim()),
           note: document.querySelector("${FILES} .folders__note")?.textContent.trim() ?? "",
         })`,
      )
      .then(JSON.parse);
  await waitFor(async () => (await state()).chips.length > 0, { what: "the type chips" });

  const unfiltered = await state();
  const chipText = unfiltered.chips.map((c) => c.text);
  // The samples directory is generated from `samples/` at build time, so this asserts the *rule* —
  // a chip per kind present, counting that kind — rather than numbers that would need editing
  // whenever a sample is added.
  const countOf = (ext) => Number(/(\d+)$/.exec(chipText.find((t) => t.startsWith(ext)) ?? "")?.[1]);
  check(
    "The folder's file list offers one chip per kind of file in it, with how many there are",
    chipText.some((t) => t.startsWith("zpcr")) &&
      chipText.some((t) => t.startsWith("pltd")) &&
      chipText.some((t) => t.startsWith("alf")) &&
      countOf("zpcr") === unfiltered.files.filter((f) => f.endsWith(".zpcr")).length,
    JSON.stringify(chipText),
  );
  // Every chip's count, added up, is the whole listing — which is both "nothing is filtered yet"
  // and "every file in the directory got counted as some kind".
  const totalCounted = chipText.reduce((n, t) => n + Number(/(\d+)$/.exec(t)?.[1] ?? 0), 0);
  check(
    "…all off to begin with, so the list opens on the whole directory",
    !unfiltered.chips.some((c) => c.on) && unfiltered.files.length === totalCounted,
    JSON.stringify({ files: unfiltered.files.length, counted: totalCounted }),
  );

  const clickChip = (ext) =>
    cdp.eval(
      `(() => { const b = [...document.querySelectorAll(".kindfilter__chip")]
           .find((x) => x.textContent.trim().startsWith(${JSON.stringify(ext)}));
         b?.click(); return !!b; })()`,
    );
  await clickChip("pltd");
  await waitFor(async () => (await state()).files.every((f) => f.endsWith(".pltd")), {
    what: "the list to narrow to plates",
  });
  const filtered = await state();
  check(
    "Turning a chip on leaves only that kind of file, which is how a long directory is searched",
    filtered.files.length === countOf("pltd") &&
      filtered.files.every((f) => f.endsWith(".pltd")) &&
      filtered.chips.filter((c) => c.on).length === 1,
    JSON.stringify(filtered.files),
  );
  // A second chip widens rather than replaces: the chips are a set of kinds to show.
  await clickChip("alf");
  await waitFor(async () => (await state()).files.some((f) => f.endsWith(".alf")), {
    what: "the reports to come back too",
  });
  const two = await state();
  check(
    "…and a second chip adds its kind rather than replacing the first",
    two.files.length === countOf("pltd") + countOf("alf") &&
      two.files.every((f) => f.endsWith(".pltd") || f.endsWith(".alf")),
    JSON.stringify(two.files),
  );

  // The way back is the same chips: nothing on is the whole listing, which is why there is no
  // separate "All" control.
  await clickChip("pltd");
  await clickChip("alf");
  await waitFor(async () => (await state()).files.length === unfiltered.files.length, {
    what: "the filter to come off",
  });
  const back = await state();
  check(
    "…and turning them all off again brings the whole directory back",
    back.files.length === unfiltered.files.length && !back.chips.some((c) => c.on),
    JSON.stringify({ files: back.files.length, on: back.chips.filter((c) => c.on).length }),
  );
  cdp.close();
}

/**
 * The bundled `samples` folder — the app's own folder, last in the same column the granted ones are
 * in. Run before {@link folderChecks} grants anything, because half of what is being asserted is
 * that it is there with no folder on disk at all.
 *
 * What is checked is what makes it *built in*: it lists itself from the build rather than from a
 * directory read, it cannot be re-read or removed, and opening a file out of it gives the app an
 * ordinary copy — editable and closable, unlike the bundled file itself — filed under
 * `samples/<name>`, so it can never displace a file of that name the user loaded themselves.
 */
async function sampleFolderChecks(chrome, origin) {
  console.log("\nbundled samples folder");
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);
  // A file first, because an empty browser gets the welcome screen instead of the view bar — the
  // bundled folder deliberately doesn't count as "something in this browser" (see `App.tsx`).
  await loadFile(cdp, ZPCR);
  await waitFor(() => chipPresent(cdp, "FirstQualification"), { what: "the .zpcr chip" });
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector(".folders__folder--builtin")`), {
    what: "the samples folder",
  });

  const BUILTIN = ".folders__folder--builtin";
  // The file column belongs to the whole tree rather than to one folder's group, so what it is
  // showing is asked of it directly — here, the only folder there is.
  const FILES = ".folders__pane--files";
  const shape = await cdp
    .eval(
      `(() => { const all = [...document.querySelectorAll(".folders__folder")];
         const b = document.querySelector("${BUILTIN}");
         return JSON.stringify({
           sections: all.length,
           last: all.at(-1) === b,
           label: b.querySelector(".folders__title")?.textContent.trim(),
           showing: b.querySelector(".folders__title.is-selected") !== null,
           buttons: [...b.querySelectorAll(".folders__actions .btn")].map((x) => x.textContent.trim()),
           trees: b.querySelectorAll(".folders__tree").length,
           files: [...document.querySelectorAll("${FILES} .folders__name")].map((x) => x.textContent.trim()),
         }); })()`,
    )
    .then(JSON.parse);
  check(
    "The app's own samples folder is there with no folder granted, and is the last one",
    shape.sections === 1 && shape.last && shape.label === "samples",
    JSON.stringify({ sections: shape.sections, last: shape.last, label: shape.label }),
  );
  // Nothing else is granted, so the one folder there is is the one the file column starts on —
  // otherwise the column would open empty on a browser whose only folder is the app's own.
  check(
    "…and is what the file column is showing, being the only folder there is",
    shape.showing && shape.files.length > 0,
    JSON.stringify({ showing: shape.showing, files: shape.files.length }),
  );
  check(
    "…with nothing to re-read and no way to remove it",
    shape.buttons.length === 0,
    JSON.stringify(shape.buttons),
  );
  check(
    "…and no tree under its heading, being one flat directory",
    shape.trees === 0,
    JSON.stringify(shape.trees),
  );
  // The listing is generated from `samples/` at build time, so this asserts the *rule* — every
  // openable file, nothing else — rather than a count that would have to be edited whenever a
  // sample is added.
  check(
    "It lists the sample files, the run the welcome screen offers among them",
    shape.files.length > 5 && shape.files.includes(EXAMPLE),
    JSON.stringify(shape.files),
  );
  check(
    "…and leaves out what the app has no decoder for, exactly as a folder on disk does",
    !shape.files.some((f) => /\.(xml|zip|md)$/i.test(f)),
    JSON.stringify(shape.files.filter((f) => /\.(xml|zip|md)$/i.test(f))),
  );

  // ── Opening one ────────────────────────────────────────────────────────────────────────────
  const sampleRow = (name) =>
    `[...document.querySelectorAll("${FILES} .folders__name")].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
  const loaded = (name) =>
    cdp.eval(
      `(() => { const b = ${sampleRow(name)};
         return !!b?.closest(".folders__file")?.querySelector(".folders__check")?.checked; })()`,
    );
  await cdp.eval(`(${sampleRow(EXAMPLE)}?.click(), undefined)`);
  await waitFor(() => loaded(EXAMPLE), { timeout: 15000, what: "the sample to open" });
  const catalog = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".filesview__filename")].map((c) => c.title))`,
    )
    .then(JSON.parse);
  check(
    "Clicking a sample opens it, and stays in Files",
    (await activeTab(cdp)) === "Files" && (await loaded(EXAMPLE)),
    await activeTab(cdp),
  );
  check(
    "…as a copy named for the folder it came out of, like any other folder's file",
    catalog.includes(`samples/${EXAMPLE}`) && !catalog.includes(EXAMPLE),
    JSON.stringify(catalog),
  );
  // Unticking closes it again — the same gesture the disk rows have, and the reason the row is a
  // checkbox at all.
  await cdp.eval(`(${sampleRow(EXAMPLE)}?.click(), undefined)`);
  await waitFor(async () => !(await loaded(EXAMPLE)), { what: "the sample to close" });
  const afterClose = await cdp
    .eval(
      `JSON.stringify([...document.querySelectorAll(".filesview__filename")].map((c) => c.title))`,
    )
    .then(JSON.parse);
  check(
    "…and clicking it again closes it, leaving the rest of the catalog alone",
    !afterClose.includes(`samples/${EXAMPLE}`) && afterClose.length === catalog.length - 1,
    JSON.stringify(afterClose),
  );

  // Double-click is the "open it and go look at it" half of the same pair — and where it goes is
  // what that kind of file is *for* (`App.tsx`'s `defaultViewFor`), which for a run is its curves.
  await cdp.eval(
    `(() => { const b = ${sampleRow(EXAMPLE)}; if (!b) return;
       for (const [type, detail] of [["click", 1], ["click", 2], ["dblclick", 2]])
         b.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
     })()`,
  );
  const landed = await tabBecomes(cdp, "Curves", 15000);
  check(
    "Double-clicking a sample run opens it and lands on its Curves, the view a run is for",
    landed === "Curves",
    JSON.stringify(landed),
  );

  // The same rule for the other two categories the samples folder holds: what a file *is* decides
  // where opening it lands, so a plate goes to the plate map and a run report to the protocol it
  // records. Overview is the fallback, not the answer.
  const doubleClickSample = async (name) => {
    await clickTab(cdp, "Files");
    await waitFor(() => cdp.eval(`!!${sampleRow(name)}`), { what: `the ${name} row` });
    await cdp.eval(
      `(() => { const b = ${sampleRow(name)}; if (!b) return;
         for (const [type, detail] of [["click", 1], ["click", 2], ["dblclick", 2]])
           b.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
       })()`,
    );
  };
  await doubleClickSample("QuickPlate_96 wells_All Channels.pltd");
  const plateTab = await tabBecomes(cdp, "Plates", 15000);
  check("…a plate file lands on Plates", plateTab === "Plates", JSON.stringify(plateTab));
  await doubleClickSample("20260807_231326_CT019138_AGBLK1.alf");
  const reportTab = await tabBecomes(cdp, "Protocol", 15000);
  check(
    "…and an .alf run report lands on Protocol, the protocol it is a record of",
    reportTab === "Protocol",
    JSON.stringify(reportTab),
  );

  // ── A link to a sample nobody has opened ───────────────────────────────────────────────────
  // A sample's name is `samples/<file>`, which says which folder it is in, so the app can go and
  // get it rather than shrugging at a name it isn't holding. Started from an empty browser and via
  // `about:blank`, because what is being asserted is how the app *starts up* on such a link.
  await emptyReload(cdp, origin);
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: `${origin}#file=samples/${EXAMPLE}&view=curves` });
  await waitFor(async () => (await catalogNames(cdp)).includes(`samples/${EXAMPLE}`), {
    timeout: 20000,
    what: "the linked sample to open itself",
  });
  const sampleLinkTab = await tabBecomes(cdp, "Curves", 15000);
  check(
    "A link to a sample the browser has never opened fetches it out of the bundled folder",
    sampleLinkTab === "Curves" && (await chipPresent(cdp, "RVP")),
    JSON.stringify({ tab: sampleLinkTab, catalog: await catalogNames(cdp) }),
  );

  cdp.close();
}

async function folderChecks(chrome, origin) {
  console.log("\ndisk folders");
  // Tree queries mean the *disk* folder's group: the bundled `samples` group is a sibling of it in
  // the same column (see sampleFolderChecks). File queries go to the one file column, which shows
  // whichever folder is picked — the disk one, throughout this check.
  const DISK = ".folders__folder:not(.folders__folder--builtin)";
  const FILES = ".folders__pane--files";
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);

  // Build the fixture in OPFS and hand it to the app in place of the native picker. `__reads`
  // counts `entries()` calls per directory, which is how the lazy-listing claim is measured.
  const install = async () => {
    await cdp.eval(
      `(async () => {
         const root = await navigator.storage.getDirectory();
         for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
         const runs = await root.getDirectoryHandle("runs", { create: true });
         const bytes = new Uint8Array(await (await fetch("/examples/${EXAMPLE}")).arrayBuffer());
         const write = async (dir, name, data) => {
           const h = await dir.getFileHandle(name, { create: true });
           const w = await h.createWritable();
           await w.write(data);
           await w.close();
         };
         // Root level: one run and one thing the app must not offer.
         await write(runs, "top.zpcr", bytes);
         await write(runs, "notes.md", "ignore me");
         // A nested level, which must stay unread until it is opened…
         const y2026 = await runs.getDirectoryHandle("2026", { create: true });
         await write(y2026, "nested.zpcr", bytes);
         // …and a sibling of it, which must stay unread even then.
         const attic = await runs.getDirectoryHandle("attic", { create: true });
         await write(attic, "old.zpcr", bytes);

         window.__opfs = root;
         window.__reads = {};
         // Count directory listings by wrapping \`entries\` on the prototype: the app's lister is
         // the only caller, so this measures exactly what it read.
         if (!window.__patched) {
           window.__patched = true;
           const real = FileSystemDirectoryHandle.prototype.entries;
           FileSystemDirectoryHandle.prototype.entries = function (...a) {
             window.__reads[this.name] = (window.__reads[this.name] ?? 0) + 1;
             return real.apply(this, a);
           };
         }
         window.showDirectoryPicker = async () => runs;
         return true;
       })()`,
      { awaitPromise: true },
    );
  };
  await install();

  // ── Adding a folder ────────────────────────────────────────────────────────────────────────
  const menuItems = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll(".dlmenu__item")].map((b) => b.textContent.trim()))`,
      )
      .then(JSON.parse);
  // The welcome screen's large drop zone carries its own "add a folder" line rather than a menu.
  const addFolder = () =>
    cdp.eval(
      `(() => { const b = document.querySelector(".dropzone__folderbtn")
           ?? [...document.querySelectorAll(".dlmenu__item")].find((x) => /Add folder/.test(x.textContent));
         if (!b) return "no control";
         b.click(); return "ok"; })()`,
    );
  check(
    "The welcome screen offers a folder as well as an upload",
    (await cdp.eval(`!!document.querySelector(".dropzone__folderbtn")`)) === true,
  );
  await addFolder();
  await waitFor(() => cdp.eval(`!!document.querySelector("${DISK}")`), {
    what: "the folder section",
  });

  const rows = () =>
    cdp
      .eval(
        `JSON.stringify({
           dirs: [...document.querySelectorAll("${DISK} .folders__dir")].map((b) => b.textContent.trim()),
           files: [...document.querySelectorAll("${FILES} .folders__name")].map((b) => b.textContent.trim()),
           crumbs: [...document.querySelectorAll("${FILES} .folders__crumb")].map((b) => b.textContent.trim()),
           selected: [...document.querySelectorAll("${DISK} .folders__dirrow.is-selected .folders__dir")]
             .map((b) => b.textContent.trim()),
           reads: window.__reads,
         })`,
      )
      .then(JSON.parse);

  /** Where the tree column sits relative to the file column — side by side, or stacked. Read from
   * the boxes themselves rather than from a class, so the container query is what is tested. */
  const paneLayout = () =>
    cdp
      .eval(
        `(() => { const t = document.querySelector(".folders__pane--tree")?.getBoundingClientRect();
           const f = document.querySelector("${FILES}")?.getBoundingClientRect();
           if (!t || !f) return "none";
           return f.left >= t.right - 1 ? "side-by-side" : "stacked"; })()`,
      );

  const first = await rows();
  check(
    "Adding a folder lists its top level — subdirectories in the tree, files beside it",
    first.dirs.includes("2026") && first.dirs.includes("attic") && first.files.includes("top.zpcr"),
    JSON.stringify(first),
  );
  check(
    "…and leaves out files it has no decoder for",
    !first.files.includes("notes.md"),
    JSON.stringify(first.files),
  );
  check(
    "…without reading a single subdirectory: a big folder costs one listing to show",
    first.reads["2026"] === undefined && first.reads["attic"] === undefined,
    JSON.stringify(first.reads),
  );
  // The tree lists directories and the file pane lists files; neither may show the other's rows,
  // which is the whole basis of the split.
  check(
    "…with directories and files in their own columns rather than one interleaved list",
    !first.dirs.includes("top.zpcr") && !first.files.includes("2026"),
    JSON.stringify({ dirs: first.dirs, files: first.files }),
  );

  // ── One file column, whichever folder is picked ────────────────────────────────────────────
  // The granted folder and the bundled `samples` are two groups in one tree column with one file
  // column between them, so exactly one folder can be the one being read — and the folder just
  // picked is it, rather than whatever the list happened to start on.
  const showing = () =>
    cdp
      .eval(
        `JSON.stringify({
           marked: [...document.querySelectorAll(".folders__title.is-selected")]
             .map((b) => b.textContent.trim()),
           crumb: document.querySelector(".folders__pane--files .folders__crumb")?.textContent.trim() ?? "",
           columns: document.querySelectorAll(".folders__pane--files").length,
         })`,
      )
      .then(JSON.parse);
  const afterAdd = await showing();
  check(
    "There is one file column for every folder, showing the folder just added",
    afterAdd.columns === 1 && afterAdd.crumb === "runs" && afterAdd.marked.join() === "runs",
    JSON.stringify(afterAdd),
  );
  // Clicking the other folder's heading moves the one column to it — and moves the mark with it,
  // so the app never claims to be showing two folders at once.
  await cdp.eval(
    `[...document.querySelectorAll(".folders__title")].find((b) => b.textContent.trim() === "samples")?.click()`,
  );
  await waitFor(async () => (await showing()).crumb === "samples", {
    what: "the file column to move to samples",
  });
  const onSamples = await showing();
  check(
    "…and clicking another folder's heading moves that column, and the mark, to it",
    onSamples.marked.join() === "samples" &&
      (await rows()).files.some((f) => f.endsWith(".zpcr")) &&
      !(await rows()).files.includes("top.zpcr"),
    JSON.stringify(onSamples),
  );
  await cdp.eval(
    `[...document.querySelectorAll(".folders__title")].find((b) => b.textContent.trim() === "runs")?.click()`,
  );
  await waitFor(async () => (await rows()).files.includes("top.zpcr"), {
    what: "the file column to come back to the disk folder",
  });

  // ── The two panes are side by side when there is room, stacked when there isn't ────────────
  const wide = await paneLayout();
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 560,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const narrow = await waitValue(paneLayout, (l) => l !== wide);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await waitValue(paneLayout, (l) => l !== narrow);
  check(
    "The tree sits beside the files when the view is wide, and above them when it isn't",
    wide === "side-by-side" && narrow === "stacked",
    JSON.stringify({ wide, narrow }),
  );

  // ── Expanding reads exactly one level ──────────────────────────────────────────────────────
  await cdp.eval(
    `[...document.querySelectorAll("${DISK} .folders__dir")].find((b) => /2026/.test(b.textContent))?.click()`,
  );
  await waitFor(async () => (await rows()).files.includes("nested.zpcr"), {
    what: "the expanded directory",
  });
  const expanded = await rows();
  check(
    "Expanding a directory reads that directory, and only it",
    expanded.reads["2026"] === 1 && expanded.reads["attic"] === undefined,
    JSON.stringify(expanded.reads),
  );
  check(
    "…and shows its files, and only its files, in the pane beside it",
    expanded.files.length === 1 && expanded.files[0] === "nested.zpcr",
    JSON.stringify(expanded.files),
  );
  check(
    "…marking it as the one being shown, with a breadcrumb saying where that is",
    expanded.selected.includes("2026") && expanded.crumbs.join("/") === "runs/2026",
    JSON.stringify({ selected: expanded.selected, crumbs: expanded.crumbs }),
  );

  // The breadcrumb is the way back up, and going up must not re-read anything.
  await cdp.eval(
    `[...document.querySelectorAll("${FILES} .folders__crumb")].find((b) => b.textContent.trim() === "runs")?.click()`,
  );
  await waitFor(async () => (await rows()).files.includes("top.zpcr"), { what: "the root's files" });
  const backUp = await rows();
  check(
    "A breadcrumb click goes back up to that directory's files, from cache",
    backUp.files.includes("top.zpcr") &&
      !backUp.files.includes("nested.zpcr") &&
      // Still the single read that adding the folder cost. Selecting a directory and expanding it
      // both want the same listing, so this also pins the in-flight de-duplication in
      // `listDirectory` — without it one click would read the same directory twice.
      backUp.reads["runs"] === 1,
    JSON.stringify({ files: backUp.files, reads: backUp.reads }),
  );
  // …and back down again, so the rest of the checks are looking at the nested file.
  await cdp.eval(
    `[...document.querySelectorAll("${DISK} .folders__dir")].find((b) => /2026/.test(b.textContent))?.click()`,
  );
  await waitFor(async () => (await rows()).files.includes("nested.zpcr"), {
    what: "the nested directory again",
  });

  // ── Opening a file off disk ────────────────────────────────────────────────────────────────
  const tickFile = (name) =>
    cdp.eval(
      `(() => { const row = [...document.querySelectorAll("${FILES} .folders__file")]
           .find((r) => r.querySelector(".folders__name")?.textContent.trim() === ${JSON.stringify(name)});
         row?.querySelector(".folders__check")?.click(); return !!row; })()`,
    );
  await tickFile("nested.zpcr");
  await waitFor(() => cdp.eval(`!!document.querySelector(".filechip")`), {
    what: "the disk-backed file's chip",
  });
  const opened = await cdp
    .eval(
      `JSON.stringify({
         names: [...document.querySelectorAll(".filesview__filename")].map((c) => c.textContent.trim()),
         titles: [...document.querySelectorAll(".filesview__filename")].map((c) => c.title),
       })`,
    )
    .then(JSON.parse);
  // Three scrolling regions, not one page: the catalog above, and the tree and file columns of the
  // folders pane below. Each has its own scrollbar, so reaching the bottom of any one of them
  // must not carry the other two off screen.
  const panes = await cdp
    .eval(
      `JSON.stringify([".filesview__pane--catalog", ".folders__pane--tree", "${FILES}"].map((sel) => {
         const p = document.querySelector(sel);
         return { sel, found: !!p, scrolls: p ? getComputedStyle(p).overflowY : null };
       }))`,
    )
    .then(JSON.parse);
  check(
    "The catalog, the folder trees and the folder's files each scroll on their own",
    panes.length === 3 &&
      panes.every((p) => p.found && (p.scrolls === "auto" || p.scrolls === "scroll")),
    JSON.stringify(panes),
  );

  // The folders panel is a fixed share of the view, not a box that grows with what is in it: a
  // panel that resized as branches were expanded would shove the table above it on every click.
  // Measured by expanding a branch and asking whether the boundary moved.
  const panelBox = () =>
    cdp
      .eval(
        `(() => { const f = document.querySelector(".filesview__pane--folders").getBoundingClientRect();
           const v = document.querySelector(".filesview").getBoundingClientRect();
           return JSON.stringify({ share: Math.round((f.height / v.height) * 100), top: Math.round(f.top) }); })()`,
      )
      .then(JSON.parse);
  const beforeExpand = await panelBox();
  await cdp.eval(
    `[...document.querySelectorAll("${DISK} .folders__twisty")].forEach((b) => b.click())`,
  );
  await sleep(400); // negative assertion: nothing should move, so there is no state to wait for
  const afterExpand = await panelBox();
  check(
    "The folders panel keeps a fixed share of the view however much is expanded inside it",
    beforeExpand.share === 40 &&
      afterExpand.share === beforeExpand.share &&
      afterExpand.top === beforeExpand.top,
    JSON.stringify({ before: beforeExpand, after: afterExpand }),
  );

  check(
    "A file opened from a folder is named by its path within that folder",
    opened.titles.includes("runs/2026/nested.zpcr"),
    JSON.stringify(opened.titles),
  );

  // Its bytes must not have been copied into IndexedDB — that is the whole point.
  const contentKeys = await cdp
    .eval(
      `new Promise((res) => { const q = indexedDB.open("zpcrweb");
         q.onsuccess = () => { const db = q.result;
           const g = db.transaction("content", "readonly").objectStore("content").getAllKeys();
           g.onsuccess = () => res(JSON.stringify(g.result.map((k) => k[0]))); }; })`,
      { awaitPromise: true },
    )
    .then(JSON.parse);
  check(
    "…and is read from disk rather than copied into the browser's storage",
    !contentKeys.some((k) => k === "runs/2026/nested.zpcr"),
    JSON.stringify([...new Set(contentKeys)]),
  );

  // ── Write-through ──────────────────────────────────────────────────────────────────────────
  const diskFile = (path) =>
    cdp.eval(
      `(async () => { let d = window.__opfs;
         const parts = ${JSON.stringify(path)};
         for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
         const f = await (await d.getFileHandle(parts.at(-1))).getFile();
         return JSON.stringify({ size: f.size, mtime: f.lastModified,
           text: new TextDecoder().decode(await f.slice(0, 4).arrayBuffer()) }); })()`,
      { awaitPromise: true },
    ).then(JSON.parse);

  // ── Click ticks it open or closed, double-click opens ──────────────────────────────────────
  // A folder is browsed by clicking through it deciding what the app should hold, so a click is
  // the row's checkbox, acts at once, and must not throw you out of the Files view the way the
  // catalog table's rows do; the double-click is what leaves, for the view that file is for.
  const nameBtn = (name) =>
    `[...document.querySelectorAll("${FILES} .folders__name")].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
  const rowSelected = (name) =>
    cdp.eval(
      `(() => { const b = ${nameBtn(name)};
         return !!b?.closest(".folders__file")?.classList.contains("is-selected"); })()`,
    );
  const rowLoaded = (name) =>
    cdp.eval(
      `(() => { const b = ${nameBtn(name)};
         return !!b?.closest(".folders__file")?.querySelector(".folders__check")?.checked; })()`,
    );
  // Open at this point (its checkbox was ticked above), so the first click closes it.
  await cdp.eval(`(${nameBtn("nested.zpcr")}?.click(), undefined)`);
  await waitFor(async () => !(await rowLoaded("nested.zpcr")), {
    what: "the clicked row to be unticked",
  });
  check(
    "Clicking a loaded file in the folder tree closes it, and stays in Files",
    (await activeTab(cdp)) === "Files" && !(await rowLoaded("nested.zpcr")),
    await activeTab(cdp),
  );
  await cdp.eval(`(${nameBtn("nested.zpcr")}?.click(), undefined)`);
  await waitFor(() => rowLoaded("nested.zpcr"), { what: "the clicked row to be ticked again" });
  check(
    "…and clicking it again reads it back off disk and selects it, still in Files",
    (await activeTab(cdp)) === "Files" &&
      (await rowLoaded("nested.zpcr")) &&
      (await rowSelected("nested.zpcr")),
    await activeTab(cdp),
  );

  // The whole sequence a browser sends, not just the `dblclick`: the click acts at once, so what
  // the pair does is the click's outcome plus the `dblclick`'s, and a bare `dblclick` would test
  // neither.
  const doubleClick = (name) =>
    cdp.eval(
      `(() => { const b = ${nameBtn(name)}; if (!b) return;
         for (const [type, detail] of [["click", 1], ["click", 2], ["dblclick", 2]])
           b.dispatchEvent(new MouseEvent(type, { bubbles: true, detail }));
       })()`,
    );
  // On a file that is already open the click unticks it and the dblclick then has nothing to go
  // to — the accepted consequence of a checkbox that acts immediately.
  await doubleClick("nested.zpcr");
  await waitFor(async () => !(await rowLoaded("nested.zpcr")), {
    what: "the double-clicked row to be unticked",
  });
  check(
    "Double-clicking a file that is already open just closes it, staying in Files",
    (await activeTab(cdp)) === "Files" && !(await rowLoaded("nested.zpcr")),
    await activeTab(cdp),
  );

  const before = await diskFile(["runs", "2026", "nested.zpcr"]);
  // Renaming the experiment rewrites the archive's own settings entry — an ordinary edit, and one
  // that has to reach the file on disk rather than IndexedDB. Double-click the file, which is
  // closed again after the check above: it opens on Curves, the view a run is for.
  await doubleClick("nested.zpcr");
  const opened2 = await tabBecomes(cdp, "Curves", 15000);
  // The click read it off disk and the dblclick followed it there, which means it waited: a file
  // that is still being decoded has nothing to show.
  const chipsAfterDbl = await cdp.eval(`document.querySelectorAll(".filechip").length`);
  check(
    "…and double-clicking a file that isn't open opens it and lands on its Curves",
    opened2 === "Curves" && chipsAfterDbl === 1,
    JSON.stringify({ tab: opened2, chips: chipsAfterDbl }),
  );
  // The rename below is an Overview affordance, so go there the way a user would.
  await clickTab(cdp, "Overview");
  await waitFor(
    () => cdp.eval(`!!document.querySelector(".overview__name, .overview__nameeditbtn")`),
    { what: "the Overview name control" },
  );
  await setExperimentName(cdp, "Renamed On Disk");
  // **The one check that waits out the real timer.** Everywhere else the suite calls
  // `flushWrites` to hurry a rate-limited write along, which is a shortcut through the same
  // listener a backgrounded tab uses — and a shortcut that works even if the timer never fires
  // at all. So exactly one place has to prove the ordinary path: an edit reaches the file on
  // disk on its own, with the tab never hidden and nothing but `DISK_WRITE_INTERVAL_MS` making
  // it happen. Don't "optimise" this one; it is the only thing standing behind the others.
  await waitFor(
    async () => (await diskFile(["runs", "2026", "nested.zpcr"])).mtime !== before.mtime,
    { timeout: 15000, what: "the edit to reach the file on disk" },
  );
  const after = await diskFile(["runs", "2026", "nested.zpcr"]);
  check(
    "An edit in the app is written back to the real file on disk",
    after.mtime !== before.mtime && after.size > 0,
    JSON.stringify({ before: before.size, after: after.size }),
  );
  check(
    "…still as a ZIP, not as loose entries",
    after.text.startsWith("PK"),
    JSON.stringify(after.text),
  );

  // ── The app's own write must not come back at it ───────────────────────────────────────────
  // Writing the file fires the watch's `modified`, so without echo suppression the app would
  // re-read what it just wrote, re-persist it, and write again — forever. Measured as "the file
  // stops changing", which is the property that actually matters, rather than as a clean console.
  //
  // A negative assertion, and the one place a *long* sleep is the point: the loop it rules out
  // would tick once per `DISK_WRITE_INTERVAL_MS` (3 s), so the wait has to outlast a full window
  // with margin, and nothing changing is exactly what is being asserted. Don't shorten it below
  // that interval, and don't convert it — there is no state to wait for.
  await sleep(5000);
  const settled = await diskFile(["runs", "2026", "nested.zpcr"]);
  check(
    "…once, and then stops: the app does not read its own write back as an external change",
    settled.mtime === after.mtime,
    JSON.stringify({ afterEdit: after.mtime, later: settled.mtime }),
  );

  // ── An external change refreshes the loaded file ───────────────────────────────────────────
  /** Rewrite a file in OPFS from outside the app. `atomic` deletes it first, which is what an
   * external editor's save-to-temp-then-rename looks like — and what kills a naive watch. */
  const externalWrite = (path, name, atomic) =>
    cdp.eval(
      `(async () => { let d = window.__opfs;
         for (const p of ${JSON.stringify(path)}) d = await d.getDirectoryHandle(p);
         const bytes = new Uint8Array(await (await fetch("/examples/${EXAMPLE}")).arrayBuffer());
         if (${atomic ? "true" : "false"}) { await d.removeEntry(${JSON.stringify(name)});
           await new Promise((r) => setTimeout(r, 150)); }
         const h = await d.getFileHandle(${JSON.stringify(name)}, { create: true });
         const w = await h.createWritable();
         await w.write(bytes);
         await w.close();
         return (await h.getFile()).lastModified; })()`,
      { awaitPromise: true },
    );

  // The app currently shows "Renamed On Disk"; writing the pristine example back over the file
  // means a refresh must show the example's own name again.
  const shownName = () =>
    cdp.eval(
      `(() => document.querySelector(".filechip.is-active .filechip__name")?.textContent.trim() ?? "")()`,
    );
  await externalWrite(["runs", "2026"], "nested.zpcr", false);
  let refreshed = "";
  try {
    await waitFor(async () => (refreshed = await shownName()) !== "Renamed On Disk", {
      timeout: 10000,
      what: "the app to notice the external write",
    });
  } catch {
    /* fall through with whatever it settled on */
  }
  check(
    "A change made to the file by another program refreshes it in the app",
    refreshed !== "" && refreshed !== "Renamed On Disk",
    JSON.stringify(refreshed),
  );

  // Now the shape that kills an un-re-armed watch. Rename again so there is something to undo.
  await setExperimentName(cdp, "Second Rename");
  await waitFor(async () => (await shownName()) === "Second Rename", { what: "the second rename" });
  // The app's own write has to reach the disk before the external one below, or the refresh that
  // follows is ambiguous about which write it noticed. That write is rate-limited to
  // `DISK_WRITE_INTERVAL_MS` (3 s), so this used to outwait the interval blind. Hiding the page
  // flushes it now instead — the same thing a real backgrounded tab does.
  //
  // Polling the file's mtime to see it land looks like the next improvement and is not: an open
  // `FileSystemWritableFileStream` holds an exclusive lock, so a reader arriving mid-write queues
  // behind it, and polling across the write window stalled the page into the 30 s CDP watchdog.
  await flushWrites(cdp);
  await sleep(400);
  await externalWrite(["runs", "2026"], "nested.zpcr", true);
  let rearmed = "";
  try {
    await waitFor(async () => (rearmed = await shownName()) !== "Second Rename", {
      timeout: 10000,
      what: "the app to notice a delete-and-recreate save",
    });
  } catch {
    /* fall through */
  }
  check(
    "…and so does a save that replaces the file rather than editing it (the watch re-arms)",
    rearmed !== "" && rearmed !== "Second Rename",
    JSON.stringify(rearmed),
  );

  // ── Across a reload ────────────────────────────────────────────────────────────────────────
  // Not `emptyReload` — the point is that the folder and the file survive the browser's storage
  // being exactly as the app left it.
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: origin });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  // The picker override and the read counter are page state, so they have to go back on.
  await cdp.eval(
    `(async () => { window.__opfs = await navigator.storage.getDirectory();
       window.__reads = {};
       const real = FileSystemDirectoryHandle.prototype.entries;
       FileSystemDirectoryHandle.prototype.entries = function (...a) {
         window.__reads[this.name] = (window.__reads[this.name] ?? 0) + 1;
         return real.apply(this, a); };
       return true; })()`,
    { awaitPromise: true },
  );
  // Wait for hydration before reaching for a tab: until the catalog is back the app can still be
  // rendering the welcome screen, and a click that lands then goes nowhere.
  await waitFor(() => cdp.eval(`!!document.querySelector(".filechip")`), {
    what: "the app to come back holding its file",
  });
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector("${DISK}")`), {
    what: "the folder after a reload",
  });
  await waitFor(async () => (await rows()).files.includes("nested.zpcr"), {
    timeout: 10000,
    what: "the auto-expanded branch",
  });
  const reloaded = await rows();
  check(
    "A granted folder, and the branch holding the open file, come back after a reload",
    reloaded.files.includes("nested.zpcr") && reloaded.dirs.includes("2026"),
    JSON.stringify(reloaded.files),
  );
  check(
    "…with the branches that hold nothing open still unread",
    reloaded.reads["attic"] === undefined,
    JSON.stringify(reloaded.reads),
  );

  // ── Double-clicking a file the app has never seen ──────────────────────────────────────────
  // The gesture has to work on a file that is only on disk too, which means reading it before
  // there is anything to open. `top.zpcr` has been sitting in the root untouched all along.
  await cdp.eval(
    `[...document.querySelectorAll("${FILES} .folders__crumb")].find((b) => b.textContent.trim() === "runs")?.click()`,
  );
  await waitFor(async () => (await rows()).files.includes("top.zpcr"), { what: "the root's files" });
  await doubleClick("top.zpcr");
  const openedDisk = await tabBecomes(cdp, "Curves", 15000);
  // Which file that is, asked back in the tree: the row it was opened from is now both loaded and
  // the selection, which no other row is.
  await clickTab(cdp, "Files");
  await waitFor(() => cdp.eval(`!!document.querySelector("${DISK}")`), {
    what: "the folder section again",
  });
  const openedRow = await cdp.eval(
    `(() => { const b = ${nameBtn("top.zpcr")}; const r = b?.closest(".folders__file");
       return JSON.stringify({ loaded: !!r?.classList.contains("is-loaded"),
         selected: !!r?.classList.contains("is-selected") }); })()`,
  );
  check(
    "Double-clicking a file that is only on disk reads it and opens it on its own view",
    openedDisk === "Curves" && JSON.parse(openedRow).loaded && JSON.parse(openedRow).selected,
    JSON.stringify({ tab: openedDisk, row: openedRow }),
  );

  // ── A link to a file that is only on disk ──────────────────────────────────────────────────
  // `attic/old.zpcr` has never been opened and sits in the one branch nothing has read all along,
  // so a link to it is a name the app has never held, in a folder it can reach. Its name *is* the
  // folder and the path, which is what lets the app go and get it — the point of sending someone
  // at the same bench a link to a run. Via `about:blank` so this is a startup, not a hash change,
  // and not `emptyReload`: the grant is what makes the file reachable.
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: `${origin}#file=runs/attic/old.zpcr&view=curves` });
  await waitFor(async () => (await catalogNames(cdp)).includes("runs/attic/old.zpcr"), {
    timeout: 20000,
    what: "the linked disk file to open itself",
  });
  const diskLinkTab = await tabBecomes(cdp, "Curves", 15000);
  const diskLinkHash = await cdp.eval(`location.hash`);
  check(
    "A link to a file only on disk opens it out of the granted folder it is named for",
    diskLinkTab === "Curves" && diskLinkHash.includes("file=runs%2Fattic%2Fold.zpcr"),
    JSON.stringify({ tab: diskLinkTab, hash: diskLinkHash }),
  );
  // A name in no folder the app can reach is still nobody's file: it must not open something else,
  // and it must not go looking beyond the directory the name points at.
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: `${origin}#file=runs/attic/absent.zpcr&view=curves` });
  // The hash losing its `file=` is the app saying the search is *over*: it is held while a name is
  // still being looked for, so waiting for it is what keeps this from passing before the look.
  const absentHash = await waitValue(() => cdp.eval(`location.hash`), (h) => !h.includes("file="), {
    what: "the unfindable name to be given up on",
  });
  check(
    "…while a link naming a file that folder doesn't hold selects nothing",
    !(await catalogNames(cdp)).includes("runs/attic/absent.zpcr") &&
      (await cdp.eval(`!!document.querySelector(".app__noselection")`)),
    JSON.stringify({ hash: absentHash, catalog: await catalogNames(cdp) }),
  );
  // Back on a real file, since the checks below open one and count what is loaded.
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: origin });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  await waitFor(() => cdp.eval(`!!document.querySelector(".filechip")`), {
    what: "the app to come back holding its files",
  });

  // ── When the grant expires underneath the app ──────────────────────────────────────────────
  // First, a *second* granted folder with a file open in it. The recovery checked below is
  // origin-wide rather than folder-wide — the browser hands back every directory the site was
  // granted, not the one handle asked about — and with only one folder there would be nothing to
  // tell the two apart.
  await cdp.eval(
    `(async () => {
       const root = await navigator.storage.getDirectory();
       const archive = await root.getDirectoryHandle("archive", { create: true });
       const bytes = new Uint8Array(await (await fetch("/examples/${EXAMPLE}")).arrayBuffer());
       const h = await archive.getFileHandle("archived.zpcr", { create: true });
       const w = await h.createWritable();
       await w.write(bytes);
       await w.close();
       window.showDirectoryPicker = async () => archive;
       return true;
     })()`,
    { awaitPromise: true },
  );
  await addFolder();
  await waitFor(() => cdp.eval(`document.querySelectorAll("${DISK}").length === 2`), {
    what: "the second folder",
  });
  await waitFor(() => cdp.eval(`!!(${nameBtn("archived.zpcr")})`), {
    what: "the second folder's listing",
  });
  // A single click, not a double: one tick opens the file and stays in Files, where the rows
  // being counted are. A double-click would navigate away once its read settled, which is a race
  // against the tab click that would follow it.
  await cdp.eval(`${nameBtn("archived.zpcr")}?.click()`);
  await waitFor(() => cdp.eval(`document.querySelectorAll(".filesview__row").length === 3`), {
    timeout: 10000,
    what: "the second folder's file to open",
  });

  // A folder grant does not survive a reload unless the browser has been told to keep it, so this
  // is the *ordinary* state of a disk-backed file the morning after — and the state the app used
  // to report as a red box of the platform's own wording, sitting over the Grant access button.
  //
  // A grant can't be revoked from CDP, and an OPFS handle is permanently granted, so the lapse is
  // reproduced where it is felt: every handle method rejects with `NotAllowedError`, which is
  // exactly what Chrome does to a real folder whose permission has gone. Installed before the
  // document so the app's own hydration read is the one that hits it, and switchable at
  // `window.__denyFs` so the checks below can play the user answering the browser's dialog.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__denyFs = true;
      for (const method of ["getFileHandle", "getDirectoryHandle"]) {
        const real = FileSystemDirectoryHandle.prototype[method];
        FileSystemDirectoryHandle.prototype[method] = function (...a) {
          return window.__denyFs
            ? Promise.reject(new DOMException("denied", "NotAllowedError"))
            : real.apply(this, a);
        };
      }
    })()`,
  });
  await navigateBlank(cdp);
  await cdp.send("Page.navigate", { url: origin });
  await waitFor(() => cdp.eval("document.readyState==='complete'"), { what: "reload" });
  await clickTab(cdp, "Files");
  const lapsed = () =>
    cdp
      .eval(
        `(() => JSON.stringify({
           rows: document.querySelectorAll(".filesview__row").length,
           badges: document.querySelectorAll(".filesview__kind.is-error").length,
           banner: !!document.querySelector(".app__error"),
         }))()`,
      )
      .then((v) => JSON.parse(v));
  try {
    await waitFor(async () => (await lapsed()).badges > 0, {
      timeout: 10000,
      what: "the unreadable badge",
    });
  } catch (e) {
    console.log("DEBUG lapsed:", JSON.stringify(await lapsed()));
    console.log("DEBUG body:", await cdp.eval(`document.body.innerText.slice(0, 600)`));
    console.log("DEBUG tab:", await activeTab(cdp));
    throw e;
  }
  const lapsedState = await lapsed();
  check(
    "A file whose folder permission has expired stays listed, with a read-error badge",
    lapsedState.rows === 3 && lapsedState.badges === 3,
    JSON.stringify(lapsedState),
  );
  check("…and says so on the row rather than in an error banner", lapsedState.banner === false);

  // Clicking it asks for the permission back — which this page will go on refusing, so what is
  // being checked is that the refusal leaves the row exactly as it was: still listed, still
  // badged, still clickable, and still not shouting.
  await cdp.eval(`document.querySelector(".filesview__row").click()`);
  // Negative assertion: the retry is refused, so the row must end up exactly as it started and
  // there is no state change to wait for.
  await sleep(600);
  const retried = await lapsed();
  check(
    "…and clicking it retries rather than dropping it",
    retried.rows === 3 && retried.badges === 3 && retried.banner === false,
    JSON.stringify(retried),
  );

  // Now the user says yes. The browser grants for the origin, not for the handle asked about, so
  // one answer covers every folder: clicking one file in `runs` has to bring back its neighbour
  // there *and* the file open in `archive`, rather than leaving them badged as unreadable when
  // they demonstrably aren't.
  await cdp.eval(`window.__denyFs = false`);
  await cdp.eval(`document.querySelector(".filesview__row").click()`);
  // The chips are the signal that the reads actually finished — a badge clears the moment its
  // file lands in the loaded set, and the file bar is drawn from that same set.
  await waitFor(() => cdp.eval(`document.querySelectorAll(".filechip").length === 3`), {
    timeout: 20000,
    what: "every file to be read back in",
  });
  const granted = await lapsed();
  // The wait above is the one that proves the reads finished; there is nothing further to wait
  // for. A second wait used to sit here for `length === 2`, left over from a two-file fixture, and
  // could never come true now that there are three — so it burned its full 10 s timeout every run
  // and threw the failure away with `.catch(() => {})`. That was a quarter of this group.
  const chipsBack = await cdp.eval(`document.querySelectorAll(".filechip").length`);
  check(
    "Granting access back reads in every open file, in every folder — not just the one clicked",
    granted.rows === 3 && granted.badges === 0 && chipsBack === 3,
    JSON.stringify({ ...granted, chips: chipsBack }),
  );
  cdp.close();
}

/**
 * A granted folder that is itself called `samples` — the one name the app already uses, for its own
 * bundled folder.
 *
 * Two sections sharing a label share everything a label identifies: the tree keys its nodes by it,
 * so the disk folder was listed from the bundled manifest instead of from the disk, and its ✕
 * matched the "this is the app's own folder, refuse" guard and silently did nothing. What is
 * asserted here is that the collision cannot happen: the bundled folder keeps `samples`, the
 * granted one comes in as `samples (2)`, each lists its own files, and the ✕ removes the one it
 * is on.
 */
async function folderNameCollisionChecks(chrome, origin) {
  console.log("\na folder named like the app's own");
  const DISK = ".folders__folder:not(.folders__folder--builtin)";
  const BUILTIN = ".folders__folder--builtin";
  const cdp = await openPage(chrome.base, origin);
  await emptyReload(cdp, origin);

  // An OPFS directory called `samples`, standing in for the picker exactly as `folderChecks` does.
  await cdp.eval(
    `(async () => {
       const root = await navigator.storage.getDirectory();
       for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
       const dir = await root.getDirectoryHandle("samples", { create: true });
       const bytes = new Uint8Array(await (await fetch("/examples/${EXAMPLE}")).arrayBuffer());
       const h = await dir.getFileHandle("mine.zpcr", { create: true });
       const w = await h.createWritable();
       await w.write(bytes);
       await w.close();
       window.showDirectoryPicker = async () => dir;
       return true;
     })()`,
    { awaitPromise: true },
  );
  await cdp.eval(
    `(() => { const b = document.querySelector(".dropzone__folderbtn")
         ?? [...document.querySelectorAll(".dlmenu__item")].find((x) => /Add folder/.test(x.textContent));
       b?.click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector("${DISK}")`), {
    what: "the folder section",
  });

  const sections = () =>
    cdp
      .eval(
        `JSON.stringify([...document.querySelectorAll(".folders__folder")].map((s) => ({
           label: s.querySelector(".folders__title")?.textContent.trim(),
           builtin: s.classList.contains("folders__folder--builtin"),
         })))`,
      )
      .then(JSON.parse);
  /** The one file column, and which folder it says it is showing — how "each lists its own files"
   * is asked now that the two groups share a column rather than each carrying a list. */
  const column = () =>
    cdp
      .eval(
        `JSON.stringify({
           crumb: document.querySelector(".folders__pane--files .folders__crumb")?.textContent.trim() ?? "",
           files: [...document.querySelectorAll(".folders__pane--files .folders__name")]
             .map((b) => b.textContent.trim()),
         })`,
      )
      .then(JSON.parse);
  /** Click a group's heading, by the label it is currently wearing. */
  const showFolder = (label) =>
    cdp.eval(
      `[...document.querySelectorAll(".folders__title")]
         .find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`,
    );
  await waitFor(async () => (await sections()).length === 2, { what: "both folders" });
  const both = await sections();
  const disk = both.find((s) => !s.builtin);
  const builtin = both.find((s) => s.builtin);
  check(
    "A folder granted under the app's own name comes in as samples (2), which keeps samples the app's",
    disk?.label === "samples (2)" && builtin?.label === "samples",
    JSON.stringify(both.map((s) => ({ label: s.label, builtin: s.builtin }))),
  );
  // Adding a folder shows it, so the column is already on the one from disk — `samples (2)`, the
  // granted one, since the app keeps `samples` for its own.
  await waitFor(async () => (await column()).files.includes("mine.zpcr"), {
    what: "the granted folder's own listing",
  });
  const onDisk = await column();
  await showFolder("samples");
  await waitFor(async () => (await column()).crumb === "samples", {
    what: "the bundled folder's listing",
  });
  const onBuiltin = await column();
  check(
    "…and each is listed from its own place rather than the two sharing one listing",
    onDisk.files.length === 1 &&
      onDisk.files[0] === "mine.zpcr" &&
      onBuiltin.files.includes(EXAMPLE) &&
      !onBuiltin.files.includes("mine.zpcr"),
    JSON.stringify({ disk: onDisk.files, builtin: onBuiltin.files.length }),
  );
  // Back to the folder on disk, so its own file is the one opened below.
  await showFolder("samples (2)");
  await waitFor(async () => (await column()).files.includes("mine.zpcr"), {
    what: "the disk folder's listing again",
  });

  // Open the folder's own file before removing it, so the app is still holding something
  // afterwards: with nothing open and no folder granted it goes back to the welcome screen, and
  // the pane being asserted about wouldn't be on screen at all.
  await cdp.eval(
    `(() => { const row = [...document.querySelectorAll(".folders__pane--files .folders__file")]
         .find((r) => r.querySelector(".folders__name")?.textContent.trim() === "mine.zpcr");
       row?.querySelector(".folders__check")?.click(); })()`,
  );
  await waitFor(() => cdp.eval(`!!document.querySelector(".filechip")`), {
    what: "the disk-backed file's chip",
  });

  // The bug as the user met it: the ✕ was there and did nothing.
  await cdp.eval(
    `[...document.querySelectorAll("${DISK} .folders__actions .btn")]
       .find((b) => b.textContent.trim() === "✕")?.click()`,
  );
  await waitFor(async () => !(await cdp.eval(`!!document.querySelector("${DISK}")`)), {
    what: "the folder to be removed",
  });
  const after = await sections();
  check(
    "…and its ✕ removes it, leaving the app's own folder alone",
    after.length === 1 && after[0].builtin && after[0].label === "samples",
    JSON.stringify(after.map((s) => s.label)),
  );
  check(
    "…while the bundled folder still has no ✕ of its own",
    (await cdp.eval(`document.querySelectorAll("${BUILTIN} .folders__actions .btn").length`)) === 0,
  );

  cdp.close();
}

async function main() {
  const pw = cfxPassword();
  if (!pw) {
    console.error(
      "uitest: no cfxPassword in secrets.json — the password checks need it (see AGENTS.md).",
    );
    process.exit(1);
  }

  const t0 = Date.now();
  // Before anything is spawned: {@link makeSeed} builds its fixture out of core's `dist/`, and a
  // stale one surfaces hundreds of checks later as a missing export. Fail here, with a real
  // reason, rather than there.
  await buildCore();
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
    await tablePickChecks(chrome, origin);
    await persistedThresholdChecks(chrome, origin, pw);
    await cqFilterChecks(chrome, origin);
    await cqDragChecks(chrome, origin);
    await wellHeaderChecks(chrome, origin);
    await referenceChecks(chrome, origin);
    await calibrationChecks(chrome, origin);
    await passwordChecks(chrome, origin, pw);
    await xmlViewChecks(chrome, origin, pw);
    await rawHexDownloadChecks(chrome, origin);
    await alfViewChecks(chrome, origin);
    await thermalProfileChecks(chrome, origin);
    await instrumentRunChecks(chrome, origin);
    await runSeedChecks(chrome, origin);
    await incompleteRunChecks(chrome, origin);
    await noPlateReadRunChecks(chrome, origin);
    await reportFileChecks(chrome, origin);
    await prclFileChecks(chrome, origin, pw);
    await explodedStorageChecks(chrome, origin);
    await experimentNameChecks(chrome, origin);
    await closeConfirmChecks(chrome, origin);
    await protocolEditorChecks(chrome, origin);
    await plateEditorChecks(chrome, origin);
    await runPlateEditChecks(chrome, origin);
    await cloneChecks(chrome, origin);
    await openFilesChecks(chrome, origin);
    await fileTypeFilterChecks(chrome, origin);
    await sampleFolderChecks(chrome, origin);
    await folderChecks(chrome, origin);
    await folderNameCollisionChecks(chrome, origin);
  } finally {
    chrome.stop();
    dev.stop();
  }

  // A wait that gave up is a failure even when the check after it passed anyway: it means the
  // suite is asserting on something it never actually saw arrive, and paying the full timeout
  // every run for the privilege. Two of these hid here for months (`harness.mjs`'s `softTimeouts`).
  for (const t of softTimeoutsSeen()) {
    results.push({ name: `a wait for ${t.what} timed out`, ok: false });
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
