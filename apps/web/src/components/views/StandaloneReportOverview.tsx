import { useMemo } from "react";
import { parseAlf } from "@zpcrweb/core";
import { OverviewPanel, type OverviewPanelProps, type InfoRow } from "./OverviewPanel";
import { DecodedAlf } from "../raw/DecodedAlf";
import { fileBytes, type LoadedFile } from "../../state/useZpcrStore";

const textDecoder = new TextDecoder("utf-8");

/**
 * The Overview tab for a standalone `.alf` run report.
 *
 * A report is the whole file rather than a summary of one, so unlike a `.prcl.txt` — whose
 * Overview is the bare identity card because its content lives on the Protocol tab — this puts the
 * decoded report right here, in {@link OverviewPanel}'s `children` slot. There is no second tab
 * for it to live on: a report has no protocol to edit, no plate, and no curves.
 *
 * What the shared identity card gains is the four things someone opening a report wants first —
 * what the run was called, when it ran, how long it took, and whether it finished cleanly. The
 * rest (the protocol as executed, the per-step log with its wall-clock durations) is
 * {@link DecodedAlf}'s, unchanged from the copy an in-archive report gets.
 *
 * This is what a thermal-only run leaves behind. The instrument writes no run folder for a
 * protocol with no plate read, so the app collects the report instead of a run file
 * (`state/useRunWatch.ts`) — and this is where that lands.
 */
export function StandaloneReportOverview({
  file,
  ...tools
}: {
  file: LoadedFile;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "onClone" | "autoEditName" | "onAutoEditHandled"
>) {
  const report = useMemo(() => {
    try {
      return parseAlf(textDecoder.decode(fileBytes(file)));
    } catch {
      // A report that no longer parses is still a file worth showing the identity card for —
      // Raw has its bytes either way.
      return null;
    }
  }, [file]);

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
