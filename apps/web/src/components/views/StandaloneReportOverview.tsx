import type { AlfReport } from "@zpcrweb/core";
import { OverviewPanel, type OverviewPanelProps, type InfoRow } from "./OverviewPanel";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.alf` run report.
 *
 * An Overview is a *prettified* view — it answers "how did this run go" in as few lines as it can,
 * and the raw view is where nothing is left out (see `ARCHITECTURE.md`, "Raw views"). So this is
 * the identity card and nothing else: what the run was called, when it ran, how long it took, the
 * outcome it reports, the instrument, and one line counting what the log holds.
 *
 * The report *whole* — every header field, the protocol it carries, all 8 error fields, every line
 * of the step log with all nine of its fields — is the Raw tab's Decoded mode (`StandaloneRawView`
 * → `DecodedAlfFile`), and the protocol also reads as an annotated listing with the thermal profile
 * beneath it on the Protocol tab. Embedding the full decode here as well, which this view used to
 * do, made Overview a scroll through the same content one tab over.
 *
 * This is what a thermal-only run leaves behind. The instrument writes no run folder for a
 * protocol with no plate read, so the app collects the report instead of a run file
 * (`state/useRunWatch.ts`) — and this is where that lands.
 */
export function StandaloneReportOverview({
  file,
  report,
  ...tools
}: {
  file: LoadedFile;
  /** The decoded report, or null when the file no longer parses as one — still worth the identity
   * card, since Raw has its bytes either way. Parsed by the caller, which needs it for the
   * Protocol tab too. */
  report: AlfReport | null;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "onClone" | "autoEditName" | "onAutoEditHandled"
>) {
  const rows: InfoRow[] = [];
  if (report) {
    const { header, errors } = report;
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
    // The shape of what ran, counted off the log rather than off the protocol — none of the three
    // is a field in the file (`alf.md` §7.2, §7.5). The log itself is the Raw tab's.
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
  }

  return <OverviewPanel file={file} rows={rows} {...tools} />;
}
