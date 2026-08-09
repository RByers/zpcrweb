/**
 * "How did that run go?" in six lines, from a decoded `.alf` run report (`alf.md`).
 *
 * The prettified reading of a report, shared by the two places that want exactly it: the Overview
 * tab of a standalone `.alf` (`StandaloneReportOverview`) and the Instrument view's account of what
 * the machine last ran (`InstrumentLastRun`). Those are the same question asked of the same file
 * from two directions — one about a file in the bar, one about a file still on the instrument — so
 * they answer it in the same words rather than drifting into two vocabularies for one report.
 *
 * Everything the report holds and this leaves out — all 15 header fields, the protocol it carries,
 * the 8 error fields, every line of the step log — is the Raw tab's decode (`DecodedAlf`), per the
 * raw-view rule in `ARCHITECTURE.md`. This is deliberately the short answer.
 */
import type { AlfReport } from "@zpcrweb/core";
import type { InfoRow } from "../components/views/OverviewPanel";

export function alfSummaryRows(report: AlfReport): InfoRow[] {
  const { header, errors } = report;
  const rows: InfoRow[] = [];
  rows.push({ label: "Run", value: header.runName || "—" });
  rows.push({
    label: "Ran",
    value: header.dateBegan
      ? `${header.dateBegan} ${header.timeBegan}–${header.timeEnd}`.trim()
      : "—",
  });
  rows.push({ label: "Took", value: header.totalElapsed || "—" });
  // The report's own verdict, not ours. `alf.md` §6: a cancelled run's flags read exactly like a
  // clean one's, so this says what the file says and claims nothing beyond it.
  rows.push({ label: "Outcome", value: errors.clean ? "No errors reported" : errors.text.trim() });
  if (header.cyclerName) rows.push({ label: "Instrument", value: header.cyclerName });
  // The shape of what ran, counted off the log rather than off the protocol — none of the three is
  // a field in the file (`alf.md` §7.2, §7.5). The log itself is the Raw tab's.
  const stages = new Set(report.steps.map((s) => s.stage)).size;
  rows.push({
    label: "Executed",
    value:
      `${report.steps.length} ${report.steps.length === 1 ? "step" : "steps"}` +
      (stages > 1 ? ` · ${stages} stages` : "") +
      (report.plateReadCount > 0
        ? ` · ${report.plateReadCount} plate read${report.plateReadCount === 1 ? "" : "s"}`
        : ""),
  });
  return rows;
}

/**
 * Who started the run, in the report's own terms — `admin` for a PC-driven one, empty for one
 * started at the instrument's touchscreen (`alf.md` §4, field 2).
 *
 * Not one of the rows above, because on a file's Overview it says nothing the user doesn't know.
 * On the Instrument view it is the whole point: it is how someone tells a run they drove from this
 * browser apart from one somebody walked up and started.
 */
export function alfStartedAt(report: AlfReport): "instrument" | "computer" {
  return report.header.user === "" ? "instrument" : "computer";
}
