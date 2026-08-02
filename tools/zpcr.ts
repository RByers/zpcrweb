/**
 * `zpcr` — a command-line face on `@zpcrweb/core` and the Curves view's analysis pipeline.
 *
 *   node_modules/.bin/vite-node tools/zpcr.ts <file.zpcr> results [--password <pw>] [--step <n>]
 *
 * `results` prints the same table the Curves view's "Table" mode shows (and its "CSV" download
 * button exports) as CSV on stdout: one row per loaded well/fluorophore pair, Cq and all.
 *
 * This is a plain-Node rerun of `useRunAnalysis` (`apps/web/src/lib/runAnalysis.ts`) with every
 * `useMemo` turned into a direct call — the deps arrays are a React re-render optimization, not
 * part of the computation, and there is no render loop here to optimize. It deliberately does
 * *not* import `runAnalysis.ts` or `state/useZpcrStore.ts`: both pull in React (a real hook call
 * outside a component throws) and browser-only state. Everything imported below is already
 * React-free — see each module's own imports.
 *
 * Needs a built core (`npm run build`; see `tools/cfx.mjs`'s own note) since `@zpcrweb/core`
 * resolves to `packages/core/dist` outside the web app's Vite dev server.
 */
import {
  buildCalibrationMatrix,
  computeCqTable,
  parseZpcrwebSettings,
  REFERENCE_ROW,
  zpcrFromFile,
  type CqTableCurve,
  type CqTableEntry,
  type PlateDefinition,
  type SampleType,
  type WellCurve,
  type Zpcr,
} from "@zpcrweb/core";
import { existsSync, readFileSync } from "node:fs";
import { csvRow } from "../apps/web/src/lib/download";
import { channelLabel } from "../apps/web/src/lib/channelColors";
import { formatBaselineFormula } from "../apps/web/src/lib/cq";
import {
  computeFluorCurves,
  dyeSpaceFluorCurves,
  matchFluorCalibrations,
  resolveTubeType,
  type FluorCalibration,
  type FluorCorrections,
} from "../apps/web/src/lib/fluorCurves";
import { NO_TARGET, targetGroups, type TargetGroup } from "../apps/web/src/lib/plateTargets";
import {
  analysisFromZpcrweb,
  defaultAnalysisSettings,
  DEFAULT_THRESHOLD_MULTIPLIER,
  type AnalysisSettings,
} from "../apps/web/src/state/analysisSettings";

function wellKey(row: number, col: number): string {
  return `${row},${col}`;
}
function curveKey(row: number, col: number, fluor: string): string {
  return `${row},${col},${fluor}`;
}

/** The subset of `RunAnalysis` (`apps/web/src/lib/runAnalysis.ts`) that a results table needs —
 * de-hooked, computed once, straight-line. */
function computeRunAnalysis(
  zpcr: Zpcr,
  settings: AnalysisSettings,
  activeStep: number | undefined,
  password: string | undefined,
) {
  const dyeSpace = !!zpcr.dyeSpace;
  const available = zpcr.channels();
  const allCurves: WellCurve[] = zpcr.curves({ includeReference: false, step: activeStep });
  const hasFileAnalysis = allCurves.some((c) => c.fileAnalysis);

  const plateEntry = zpcr.plates(password)[0];
  const plate: PlateDefinition | undefined = plateEntry?.pltd.plate;
  const calibrations = zpcr.calibrations();
  const tube = resolveTubeType(plate?.plateName);

  const fluorCals: FluorCalibration[] = plate
    ? matchFluorCalibrations(plate.fluors, calibrations, tube)
    : [];
  const calibratedFluors = dyeSpace ? fluorCals : fluorCals.filter((f) => f.curve);

  const loadedFluors = new Map<string, Set<string>>();
  if (plate) {
    for (const w of plate.wells) {
      if (w.loaded) loadedFluors.set(wellKey(w.row, w.col), new Set(w.fluors.map((f) => f.fluor)));
    }
  }
  const wellFluorTargets = new Map<string, Map<string, string>>();
  if (plate) {
    for (const w of plate.wells) {
      const inner = new Map<string, string>();
      for (const wf of w.fluors) if (wf.target) inner.set(wf.fluor, wf.target);
      wellFluorTargets.set(wellKey(w.row, w.col), inner);
    }
  }

  const targetInfos: TargetGroup[] = plate ? targetGroups(plate, fluorCals) : [];
  const usingTargets = targetInfos.length > 0;
  const groupInfos: TargetGroup[] = usingTargets
    ? targetInfos
    : fluorCals.map((f) => ({ target: f.fluor, fluors: [f.fluor], channel: f.channel, curve: f.curve }));

  const groupOf = (row: number, col: number, fluor: string) =>
    usingTargets ? (wellFluorTargets.get(wellKey(row, col))?.get(fluor) ?? NO_TARGET) : fluor;

  const temps = zpcr.reads
    .filter((r) => r.step === activeStep)
    .map((r) => r.blockTempC)
    .filter((t): t is number => t != null);
  const stepTemperatureC = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : 60;

  const matrix =
    dyeSpace || calibratedFluors.length === 0
      ? null
      : buildCalibrationMatrix(
          calibratedFluors.map((f) => f.curve!),
          stepTemperatureC,
          { normalization: settings.calibrationNormalization, channels: available },
        );

  const reads = zpcr.reads.filter((r) => r.step === activeStep);
  const corrections: FluorCorrections = {
    referenceLevel: available.map((ch) => reads.map((r) => r.wells[ch]![REFERENCE_ROW]![0]!.mean)),
  };

  const allFluorCurves = dyeSpace
    ? dyeSpaceFluorCurves(
        allCurves,
        (ch) => new Map(plate?.fluors.map((f) => [f.channel, f.fluor]) ?? []).get(ch),
      )
    : matrix
      ? computeFluorCurves(
          allCurves,
          matrix,
          available,
          calibratedFluors.map((f) => f.channel),
          corrections,
        )
      : [];

  const computed = computeCqTable(
    allFluorCurves.map(
      (c): CqTableCurve => ({
        key: curveKey(c.row, c.col, c.dye),
        group: c.dye,
        cycles: c.cycles,
        values: c.mean,
        contributesToThreshold: loadedFluors.get(wellKey(c.row, c.col))?.has(c.dye) ?? false,
      }),
    ),
    {
      thresholdOverrides: settings.thresholdOverrides,
      curveThresholdOverrides: settings.curveThresholdOverrides,
      autoThreshold: { multiplier: settings.thresholdMultiplier },
    },
  );
  let cqTable: Map<string, CqTableEntry>;
  if (!hasFileAnalysis) {
    cqTable = computed;
  } else {
    cqTable = new Map();
    for (const c of allFluorCurves) {
      const key = curveKey(c.row, c.col, c.dye);
      const entry = computed.get(key);
      if (!entry) continue;
      if (!c.fileAnalysis) {
        cqTable.set(key, entry);
        continue;
      }
      // "file" is this CLI's fixed baseline/Cq source — see the header note.
      cqTable.set(key, {
        ...entry,
        cq: c.fileAnalysis.cq,
        threshold: c.fileAnalysis.threshold,
        endRfu: c.fileAnalysis.endRfu,
      });
    }
  }

  return { plateEntry, plate, cqTable, groupInfos, groupOf, usingTargets };
}

interface ResultRow {
  wellLabel: string;
  sample: string;
  sampleType: SampleType;
  fluor: string;
  target: string;
  channel?: number | null;
  baselineFormula: string;
  threshold: number;
  cq: number | null;
  deltaRfu: number;
  endRfu: number;
}

function buildResultRows(run: ReturnType<typeof computeRunAnalysis>): ResultRow[] {
  const { plate, cqTable, groupInfos, groupOf } = run;
  if (!plate || cqTable.size === 0) return [];
  const out: ResultRow[] = [];
  for (const w of plate.wells) {
    if (!w.loaded) continue;
    for (const wf of w.fluors) {
      const group = groupOf(w.row, w.col, wf.fluor);
      if (!group) continue;
      const entry = cqTable.get(curveKey(w.row, w.col, wf.fluor));
      if (!entry) continue;
      const info = groupInfos.find((g) => g.target === group);
      out.push({
        wellLabel: w.label,
        sample: w.sample ?? "",
        sampleType: w.sampleType,
        fluor: wf.fluor,
        target: group,
        channel: info?.channel ?? wf.channel,
        baselineFormula: formatBaselineFormula(entry.baselineFit),
        threshold: entry.threshold,
        cq: entry.cq,
        deltaRfu: entry.deltaRfu,
        endRfu: entry.endRfu,
      });
    }
  }
  return out.sort((a, b) => a.target.localeCompare(b.target) || a.wellLabel.localeCompare(b.wellLabel));
}

/** Same columns/precision as the Curves view's own CSV download (`analysisRows.ts`'s `analysisCsv`). */
function resultsCsv(rows: ResultRow[]): string {
  let csv = csvRow([
    "well",
    "sample",
    "sampleType",
    "fluor",
    "target",
    "channel",
    "baseline",
    "threshold",
    "cq",
    "deltaRfu",
    "endRfu",
  ]);
  for (const r of rows) {
    csv += csvRow([
      r.wellLabel,
      r.sample,
      r.sampleType,
      r.fluor,
      r.target,
      channelLabel(r.channel),
      r.baselineFormula,
      r.threshold.toFixed(1),
      r.cq != null ? r.cq.toFixed(3) : "",
      r.deltaRfu.toFixed(1),
      r.endRfu.toFixed(1),
    ]);
  }
  return csv;
}

/** The local, gitignored CFX ZipCrypto password — see `CLAUDE.md`'s Secrets section and
 * `packages/core/test/secrets.ts`, which this mirrors. `undefined` when there's no `secrets.json`. */
function readCfxPassword(): string | undefined {
  const path = new URL("../secrets.json", import.meta.url);
  if (!existsSync(path)) return undefined;
  const secrets = JSON.parse(readFileSync(path, "utf-8")) as { cfxPassword?: string };
  return secrets.cfxPassword;
}

function usage(): never {
  console.error(
    "usage: zpcr <file.zpcr> results [--password <pw>] [--step <n>]\n\n" +
      "Prints the run's results table (as shown in the Curves view's Table mode) as CSV.",
  );
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const [file, cmd, ...rest] = argv;
  if (!file || !cmd) usage();
  if (cmd !== "results") {
    console.error(`unknown command: ${cmd}`);
    usage();
  }

  let password: string | undefined;
  let step: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--password") password = rest[++i];
    else if (rest[i] === "--step") step = Number(rest[++i]);
    else usage();
  }

  const zpcr = await zpcrFromFile(file!);

  let plateEntry = zpcr.plates(password)[0];
  if (plateEntry?.pltd.needsPassword && password == null) {
    password = readCfxPassword();
    if (password != null) plateEntry = zpcr.plates(password)[0];
  }
  if (plateEntry?.pltd.needsPassword) {
    console.error(
      `${file}: plate data is password-protected. Pass --password, or set cfxPassword in secrets.json.`,
    );
    process.exit(1);
  }
  if (plateEntry?.pltd.error) {
    console.error(`${file}: failed to decode plate data: ${plateEntry.pltd.error}`);
    process.exit(1);
  }

  const fromFile = parseZpcrwebSettings(zpcr);
  let settings = analysisFromZpcrweb(fromFile);
  if (!fromFile?.analysis?.thresholdOverrides && zpcr.persistedThresholds) {
    settings = { ...settings, thresholdOverrides: new Map(zpcr.persistedThresholds) };
  }
  settings = { ...defaultAnalysisSettings(), ...settings };
  if (settings.thresholdMultiplier == null) settings.thresholdMultiplier = DEFAULT_THRESHOLD_MULTIPLIER;

  const steps = zpcr.steps();
  const activeStep = step != null && !Number.isNaN(step) ? step : (steps[0]?.step ?? undefined);

  const run = computeRunAnalysis(zpcr, settings, activeStep, password);
  process.stdout.write(resultsCsv(buildResultRows(run)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
