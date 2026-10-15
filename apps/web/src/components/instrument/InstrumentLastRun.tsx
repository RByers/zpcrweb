/**
 * What this instrument last ran — read off the machine itself the moment it connects.
 *
 * The instrument keeps one run report, in `\Storage Card\PCRunReport`, and writes one for **every**
 * run it performs (`usb.md` §5.2): a full qPCR run, an incubation with no plate read, and a run
 * somebody started at the touchscreen with no computer attached at all. That makes it the one
 * place that answers "what did this machine last do?" — unlike the run folder, which exists only
 * for a run with a `PLATEREAD` and otherwise still holds whatever the last such run left there.
 *
 * So the connection reads it, unasked, once (`useCfxDevice`'s `refreshLastReport`), and this rail
 * section is where it lands — collapsed, in the Instrument view's rail, because it is a fact about
 * the machine and not about whichever file is selected. Two things it is for, in order of how
 * often they matter:
 *
 * - **Connecting and seeing where you are.** The run on the block is over, the browser was closed,
 *   and this says what happened without opening anything.
 * - **Not losing it.** The report is deleted at the start of the next run — that is what CFX
 *   Manager does and what this app copies — so a report nobody has looked at is a report about to
 *   go. "Open report" puts it in the file bar as a file of the user's, which is the same thing a
 *   thermal-only run's report does automatically when this app is the one driving.
 *
 * The report a *watched* run produces arrives on its own (`useRunWatch`), so this section is not
 * how results are collected. It is the account of the run before the browser got here.
 */
import { useState } from "react";
import { alfSummaryRows, alfStartedAt } from "../../lib/alfSummary";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import { Stat } from "./instrumentParts";

export function InstrumentLastRun({
  instrument,
  onOpenReport,
}: {
  instrument: CfxDeviceHandle;
  /** Put the report in the file bar, exactly as a dropped `.alf` would land — `App`'s `openReport`,
   * the same callback the run watcher files a thermal-only run's report through. */
  onOpenReport: (name: string, bytes: Uint8Array) => Promise<string | null>;
}) {
  const { connection, lastReport, refreshLastReport, busy, runPending, status } = instrument;
  const [opened, setOpened] = useState<string | null>(null);

  // The section is about the machine on the other end of the cable; with no cable there is nothing
  // it could be describing, and a stale report from a previous session would be a lie.
  if (connection !== "connected") return null;

  // A run in progress is about to write the *next* report, and the one that was here has already
  // been deleted by its pre-flight (`usb.md` §7.1) — so say what is happening rather than showing
  // an empty section that reads like the instrument has never run anything.
  const running = status?.running === true || runPending;
  const report = lastReport?.report ?? null;

  const open = async () => {
    if (!lastReport) return;
    const id = await onOpenReport(lastReport.name, lastReport.bytes);
    if (id) setOpened(id);
  };

  return (
    // Collapsed, like Identity: it describes the run before this browser got here, which is worth
    // a glance on demand rather than permanent space above the buttons that matter mid-run.
    <details className="rail__section rail__details instrument__lastrun">
      <summary className="rail__title">
        <span>
          <span className="rail__chevron" aria-hidden="true">
            ▸
          </span>
          Last run
        </span>
      </summary>

      {running ? (
        <div className="rail__note">
          A run is under way. Its report is written when it finishes, and will appear here then —
          the previous one was cleared when this run started.
        </div>
      ) : !lastReport ? (
        <>
          <div className="rail__note">
            The instrument is holding no run report. It keeps only the most recent one, and clears
            it at the start of every run, so this is what you see after a run whose report has
            already been taken.
          </div>
          <div className="instrument__lastrunactions">
            <button
              className="btn btn--sm"
              onClick={() => void refreshLastReport()}
              disabled={!!busy}
            >
              Check again
            </button>
          </div>
        </>
      ) : (
        <>
          {report ? (
            <>
              {alfSummaryRows(report).map((r) => (
                <Stat key={r.label} label={r.label} value={r.value} />
              ))}
              {/* Not one of the shared rows: on a file's Overview "who started it" tells the
                  reader nothing, and here it is the whole distinction between a run this
                  browser drove and one somebody started at the machine. */}
              <Stat
                label="Started"
                value={
                  alfStartedAt(report) === "instrument"
                    ? "at the instrument"
                    : `from a computer (${report.header.user})`
                }
              />
              <div className="rail__note instrument__footnote">
                Read from the instrument, not from a file — it keeps one report and replaces it at
                the start of the next run. Open it to keep a copy.
              </div>
            </>
          ) : (
            <div className="rail__note">
              The instrument is holding a report, but its contents could not be read as one. Its
              bytes are still here — open it to look at them.
            </div>
          )}
          <div className="instrument__lastrunactions">
            <button
              className="btn btn--primary btn--sm"
              onClick={() => void open()}
              disabled={!!busy}
              title={lastReport.name}
            >
              Open report
            </button>
            <button
              className="btn btn--sm"
              onClick={() => void refreshLastReport()}
              disabled={!!busy}
            >
              Re-read
            </button>
          </div>
          {opened && <div className="rail__note mono">In the file bar as {opened}</div>}
        </>
      )}
    </details>
  );
}
