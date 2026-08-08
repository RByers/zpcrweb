import type { AlfReport } from "@zpcrweb/core";
import { OverviewPanel, type OverviewPanelProps, type InfoRow } from "./OverviewPanel";
import { DecodedAlf } from "../raw/DecodedAlf";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.alf` run report.
 *
 * A report is the whole file rather than a summary of one, so this puts the decoded report right
 * here, in {@link OverviewPanel}'s `children` slot: the identity card leads with the four things
 * someone opening a report wants first — what the run was called, when it ran, how long it took,
 * and whether it finished cleanly — and {@link DecodedAlf} follows with the rest of the header, the
 * error flags and the executed-step log, the same copy an in-archive report gets in the Raw view.
 *
 * What is deliberately *not* here is the protocol the report carries. That is the Protocol tab's
 * (`ProtocolView`), where it reads as its annotated listing, with the step log plotted beneath it
 * as a thermal profile against the clock. The plot and the table are not two renderings of one
 * thing in the way two protocol listings would be: the plot is the shape of the run, the table is
 * what each logged line actually says.
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
  }

  return (
    <OverviewPanel file={file} rows={rows} {...tools}>
      {report && <DecodedAlf report={report} />}
    </OverviewPanel>
  );
}
