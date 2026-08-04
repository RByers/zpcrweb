#!/usr/bin/env node
/**
 * `zpcr` — a command-line face on `@zpcrweb/core`'s run-analysis pipeline.
 *
 *   node tools/zpcr.mjs <file.zpcr> results [--password <pw>] [--step <n>]
 *
 * `results` prints a run's results table — the same one the web app's Curves view shows in
 * Table mode and downloads as CSV — as CSV on stdout: one row per loaded well/fluorophore pair,
 * Cq and all.
 *
 * Every number here comes straight from `computeRunAnalysis`/`buildAnalysisRows`/`analysisCsv`
 * (`packages/core/src/runAnalysis.ts` and `analysisRows.ts`) — the library's own derivation, not
 * a second copy of it. This file is wiring: argv parsing, the password fallback, and nothing
 * that touches a Cq, a threshold, or a baseline.
 *
 * Needs a built core (`npm run build`) — this runs with plain Node, no bundler, so it resolves
 * `@zpcrweb/core` to `packages/core/dist` the same way any other consumer of the published
 * package would (see `tools/cfx.mjs`'s own note).
 */
import { existsSync, readFileSync } from "node:fs";
import {
  analysisCsv,
  buildAnalysisRows,
  computeRunAnalysis,
  parseZpcrwebSettings,
  runAnalysisSettingsFromZpcrweb,
  zpcrFromFile,
} from "../packages/core/dist/index.js";

/** The local, gitignored CFX ZipCrypto password — see `AGENTS.md`'s Secrets section and
 * `packages/core/test/secrets.ts`, which this mirrors. `undefined` when there's no `secrets.json`. */
function readCfxPassword() {
  const path = new URL("../secrets.json", import.meta.url);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")).cfxPassword;
}

function usage() {
  console.error(
    "usage: zpcr <file.zpcr> results [--password <pw>] [--step <n>]\n\n" +
      "Prints the run's results table (as shown in the web app's Curves view Table mode) as CSV.",
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

  let password;
  let step;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--password") password = rest[++i];
    else if (rest[i] === "--step") step = Number(rest[++i]);
    else usage();
  }

  const zpcr = await zpcrFromFile(file);

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

  const settings = runAnalysisSettingsFromZpcrweb(parseZpcrwebSettings(zpcr));
  // A `.pcrd` that CFX saved with `autoCalculateThreshold="False"` carries the threshold the
  // instrument's own analysis used, per fluorophore (`threshold.md` §5.3) — `zpcrweb.json`
  // outranks it, since that's this library's own record of the same decision, written later.
  if (!settings.thresholdOverrides && zpcr.persistedThresholds) {
    settings.thresholdOverrides = zpcr.persistedThresholds;
  }

  const activeStep = step != null && !Number.isNaN(step) ? step : (zpcr.steps()[0]?.step ?? undefined);

  const run = computeRunAnalysis(zpcr, settings, activeStep, password);
  process.stdout.write(analysisCsv(buildAnalysisRows(run, () => true)));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
