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
 * and whether it finished cleanly — and {@link DecodedAlf} follows with the rest of the header and
 * the error flags, the same copy an in-archive report gets in the Raw view.
 *
 * What is deliberately *not* here is the protocol the report carries and the wall-clock cost of
 * running it. Those are the Protocol tab's (`ProtocolView`), where the protocol reads as its
 * annotated listing and the step log reads as a thermal profile against the clock. A report is the
 * one file where the same tab could plausibly have held everything, and holding everything is what
 * made it a scroll rather than an answer.
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
