import type { AlfReport } from "@zpcrweb/core";
import { OverviewPanel, type OverviewPanelProps, type InfoRow } from "./OverviewPanel";
import { alfSummaryRows } from "../../lib/alfSummary";
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
  // The same six lines the Instrument view's last-run panel shows, from the same helper — see
  // `lib/alfSummary.ts`.
  const rows: InfoRow[] = report ? alfSummaryRows(report) : [];

  return <OverviewPanel file={file} rows={rows} {...tools} />;
}
