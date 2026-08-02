import { formatRunDefinitionText, type Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { DownloadIcon } from "../DownloadIcon";
import { CloneIcon } from "../CloneIcon";
import { downloadText } from "../../lib/download";
import { protocolFileBase } from "../../lib/protocolSource";
import type { AddFilesOptions } from "../../state/useZpcrStore";

/** The "Protocol" tab for a run (`.zpcr`/`.pcrd`/Biomeme): the thermal-cycling protocol the run
 * carries — structured step list when one parsed, or the annotated ASCII run definition
 * otherwise — plus the download/clone tools that used to sit inline in `OverviewView`. Moved out
 * to its own tab so Overview stays a summary rather than growing a protocol's worth of detail. */
export function ProtocolView({
  zpcr,
  file,
  addFiles,
}: {
  zpcr: Zpcr;
  /** Only its `name` is used, as the download/clone filename's fallback base. */
  file: { name: string };
  /** Adds the cloned `.prcl.txt` to the file list — see the Clone button below. */
  addFiles: (files: FileList | File[], options?: AddFilesOptions) => Promise<string | null>;
}) {
  const protocolText = zpcr.protocolText || null;
  const protocol = zpcr.protocol();
  const protocolName = protocol?.name || null;

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
    </div>
  );
}
