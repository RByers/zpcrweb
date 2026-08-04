import { useMemo } from "react";
import { formatRunDefinitionText, ProtocolBuilder, type Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { ProtocolEditor } from "../protocol/ProtocolEditor";
import { ThermalProfileChart } from "../protocol/ThermalProfileChart";
import { DownloadIcon } from "../DownloadIcon";
import { CloneIcon } from "../CloneIcon";
import { downloadText } from "../../lib/download";
import { protocolFileBase } from "../../lib/protocolFileBase";
import type { AddFilesOptions } from "../../state/useZpcrStore";

/**
 * The "Protocol" tab for a run (`.zpcr`/`.pcrd`/Biomeme): the thermal-cycling protocol the run
 * carries — structured step list when one parsed, or the annotated ASCII run definition otherwise —
 * plus the download/clone tools that used to sit inline in `OverviewView`. Moved out to its own tab
 * so Overview stays a summary rather than growing a protocol's worth of detail.
 *
 * **For a pending experiment this tab is an editor instead**, the same {@link ProtocolEditor} a
 * standalone `.prcl.txt` gets, writing straight into the experiment's own archive entry
 * (`setRunProtocolText`). That is the difference between the two states, and it is the whole reason
 * "pending" is a state: an experiment that hasn't run yet *has no record to contradict*, so its
 * protocol is a draft and editing it is the ordinary thing to do — which is what makes "start from
 * scratch" possible without authoring a separate file first. A brand-new experiment has no protocol
 * at all yet, so the editor opens on the blank default (`ProtocolBuilder.empty()`: the three-line
 * header and `END`), ready to be typed into.
 *
 * The moment the experiment is started it stops being pending, permanently, and this tab reverts to
 * the read-only rendering below — a run's protocol is a record of what the block was asked to do,
 * and there would be no honest way to edit it after the fact.
 *
 * Beneath it, when the run carries a `.alf` report, what the block *actually* did: the same
 * protocol as the instrument executed it, plotted against wall-clock time (`alf.md` §7.6). The
 * pairing is the point — the table above states the intent, the plot below states the cost, and
 * a hold that ran 46 s for its nominal 30 is only visible in the second. Runs without a report
 * (`.pcrd`, Biomeme, and a pending experiment, which has run nothing) simply don't get the section.
 */
export function ProtocolView({
  zpcr,
  file,
  addFiles,
  pending,
  onChangeProtocol,
}: {
  zpcr: Zpcr;
  /** Only its `name` is used, as the download/clone filename's fallback base. */
  file: { name: string };
  /** Adds the cloned `.prcl.txt` to the file list — see the Clone button below. */
  addFiles: (files: FileList | File[], options?: AddFilesOptions) => Promise<string | null>;
  /** This run is a pending experiment, so its protocol is a draft — see the module comment. */
  pending: boolean;
  /** Persist an edited protocol into the experiment's archive (the store's `setRunProtocolText`).
   * Only called while {@link pending}. */
  onChangeProtocol: (runDefinition: string) => void;
}) {
  const protocolText = zpcr.protocolText || null;
  const protocol = zpcr.protocol();
  const protocolName = protocol?.name || null;
  // One report per archive in every sample examined (alf.md §1); the first is the run's own.
  const report = useMemo(() => zpcr.runReports()[0]?.alf ?? null, [zpcr]);
  /** What a pending experiment with no protocol yet starts from: the header and `END`, nothing
   * else. Only built when it's needed, since a run that has one never asks. */
  const draft = useMemo(
    () => (pending && !protocolText ? ProtocolBuilder.empty().toRunDefinition() : null),
    [pending, protocolText],
  );

  if (pending) {
    return (
      <div className="overview">
        <ProtocolEditor
          runDefinition={protocolText ?? draft!}
          onChange={onChangeProtocol}
          fileName={file.name}
        />
      </div>
    );
  }

  if (!protocol?.steps && !protocolText) {
    return (
      <div className="overview">
        <div className="decoded__na mono">No thermal protocol for this run.</div>
      </div>
    );
  }

  return (
    <div className="overview">
      <section className="overview__block">
        <div className="overview__blockhead">
          <h2 className="overview__h">Thermal protocol</h2>
          {/* The ASCII run definition, not the `.prcl` — see the button's own title. Offered
              only when the run carries that text form at all; a run whose protocol is
              structured-only would have nothing to write. */}
          {protocolText && (
            <div className="overview__blocktools">
              <button
                className="raw__download"
                onClick={() =>
                  downloadText(
                    `${protocolFileBase(protocolName, file.name)}.prcl.txt`,
                    formatRunDefinitionText(protocolText),
                  )
                }
                aria-label="Download the thermal protocol as .prcl.txt"
                title={
                  "Download the ASCII run definition as .prcl.txt — one directive per line. " +
                  "This is the form the instrument itself records, and what the Instrument view " +
                  "loads to stage a protocol for a new run."
                }
              >
                <DownloadIcon />
              </button>
              <button
                className="raw__download"
                onClick={() => {
                  const name = `${protocolFileBase(protocolName, file.name)}.prcl.txt`;
                  const text = formatRunDefinitionText(protocolText);
                  void addFiles([new File([new TextEncoder().encode(text)], name)]);
                }}
                aria-label="Clone the thermal protocol into an independent .prcl.txt file"
                title="Extract this protocol into its own .prcl.txt file, kept alongside your other files"
              >
                <CloneIcon />
              </button>
            </div>
          )}
        </div>
        {protocol?.steps ? (
          <ProtocolStepsTable steps={protocol.steps} />
        ) : (
          <ProtocolDecoded text={protocolText!} />
        )}
      </section>

      {report && (
        <section className="overview__block">
          <h2 className="overview__h">Thermal profile as run</h2>
          <p className="decoded__hint">
            A visualization of the <code>.alf</code> run report stored with this run — the
            instrument's own record of what the block actually did, timed against the clock rather
            than against the protocol above. Each step slopes up or down while the block travels to
            its setpoint, then runs flat for the hold at it, so the time a temperature change cost
            is the width of the slope.{" "}
            <span className="thermal__key thermal__key--read">Plate reads</span> are numbered in the
            order they were taken; every read is a point, though only as many numbers are drawn as
            fit. The very first approach isn't drawn — nothing records what the block was at before
            the run started.
          </p>
          <ThermalProfileChart report={report} />
        </section>
      )}
    </div>
  );
}
