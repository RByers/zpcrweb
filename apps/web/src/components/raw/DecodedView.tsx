import { useMemo } from "react";
import { isAlfName, parseRunDefinition, parseRunInfoRaw, type Zpcr } from "@zpcrweb/core";
import { DecodedAlfFile } from "./DecodedAlf";
import { DecodedPlateread } from "./DecodedPlateread";
import { DecodedPlate } from "./DecodedPlate";
import { DecodedDcalFile } from "./DecodedDcal";
import { DecodedProtocol } from "./DecodedProtocol";
import { RunLogTable } from "./RunLogTable";
import { parseRunLog } from "../../lib/runlog";
import { XmlTreeFromString } from "../../lib/xmlTree";

/** Which typed decoder (if any) applies to an archive entry. Used for `.zpcr`'s real archive
 * entries only — a `.pcrd`'s document tree (`PcrdRawView`) dispatches on the real XML node it
 * represents instead, since it has no filenames to match against. */
export type DecodedKind =
  | "plateread"
  | "plate"
  | "prcl"
  | "dcal"
  | "runinfo"
  | "runlog"
  | "protocol"
  | "alf"
  | "xml"
  | null;

export function decodedKind(name: string): DecodedKind {
  if (/\.Plateread$/i.test(name)) return "plateread";
  if (/\.pltd$/i.test(name) || /\.plt\.csv$/i.test(name)) return "plate";
  if (/\.prcl$/i.test(name)) return "prcl";
  if (/\.dcal$/i.test(name)) return "dcal";
  if (/RunInfo\.xml$/i.test(name)) return "runinfo";
  if (/runlog\.xml$/i.test(name)) return "runlog";
  if (/ProtocolRunDefinition\.txt$/i.test(name)) return "protocol";
  if (isAlfName(name)) return "alf";
  if (/\.xml$/i.test(name)) return "xml";
  return null;
}

interface Props {
  zpcr: Zpcr;
  name: string;
}

export function DecodedView({ zpcr, name }: Props) {
  const kind = decodedKind(name);

  if (kind === "plateread") {
    const read = zpcr.reads.find((r) => r.fileName === name);
    if (!read) return <div className="decoded__na mono">No decoded read for {name}.</div>;
    return <DecodedPlateread read={read} />;
  }

  if (kind === "plate") return <DecodedPlate zpcr={zpcr} name={name} />;
  if (kind === "prcl") return <DecodedProtocol zpcr={zpcr} name={name} />;
  if (kind === "dcal") return <DecodedDcalFile zpcr={zpcr} name={name} />;
  if (kind === "runinfo") return <RunInfoTable text={zpcr.archive.text(name)} />;
  if (kind === "runlog") return <RunLogTable parsed={parseRunLog(zpcr.archive.text(name))} />;
  if (kind === "protocol") return <ProtocolDecoded text={zpcr.archive.text(name)} />;
  if (kind === "alf") return <DecodedAlfFile text={zpcr.archive.text(name)} />;
  if (kind === "xml") return <XmlTreeFromString xml={zpcr.archive.text(name)} />;

  return <div className="decoded__na mono">No decoder for this file.</div>;
}

/** A flat list of KeyValuePairs (`.zpcr`'s real `RunInfo.xml`, or a `.pcrd`'s
 * `protocolRunInfo/RunInfo` subtree, same schema either way) — rendered as a 2-column table. */
export function RunInfoTable({ text }: { text: string }) {
  const entries = useMemo(() => Object.entries(parseRunInfoRaw(text)), [text]);
  return (
    <div className="decoded">
      <table className="decoded__tbl decoded__kv mono">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k}>
              <td className="decoded__k">{k}</td>
              <td className="decoded__v">{v === "" ? <span className="decoded__empty">∅</span> : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A `;`-separated thermal protocol program (`.zpcr`'s real `ProtocolRunDefinition.txt`, a
 * `.pcrd`'s `protocol2 runDefinition` attribute, or a plaintext `.prcl`'s `runDefinition` —
 * same one-line format either way).
 *
 * Nothing here knows what a directive means: `parseRunDefinition` (core, `protocol.md`) supplies
 * the step numbers `GOTO` counts in and the plain-English reading shown beside each line, and
 * this renders the directive text as written with that reading to its right.
 *
 * With `annotated={false}` the reading is dropped and only the program itself is listed — one
 * directive per line, numbered as the instrument numbers them. That is what the Instrument view's
 * staging panel wants: there the protocol sits beside a plate map in half the width, and the
 * gloss is a thing you read once, on Overview, not every time you check what would be sent.
 *
 * The one exception is a scan mask (`PLATEREAD`/`MELT`'s `#h<hex>` operand, `usb.md` §3.1), which
 * stays even unannotated, in smaller type on a line of its own: unlike a temperature or a hold
 * time, that operand is a *packed byte* — which channels are read and how the head sweeps the
 * plate are not readable from `#h3F`, and they are exactly what someone checks before a run.
 */
export function ProtocolDecoded({
  text,
  annotated = true,
  activeStepNumber,
}: {
  text: string;
  annotated?: boolean;
  /** The step the instrument reports it's on right now (`CfxStatus.step`), or `null`/`undefined`
   * when nothing is running. Matched against `d.stepNumber` to mark that line, so the STATUS?
   * poll gives someone watching a run something more useful than a number to cross-reference. */
  activeStepNumber?: number | null;
}) {
  const program = useMemo(() => parseRunDefinition(text), [text]);
  return (
    <div className="decoded">
      <div className="decoded__proto mono">
        {program.directives.map((d) => {
          const scan = "scanMask" in d ? d.scanMask : undefined;
          const active = activeStepNumber != null && d.stepNumber === activeStepNumber;
          return (
            <div
              key={d.index}
              className={"decoded__protoline" + (active ? " is-active" : "")}
            >
              <span className="decoded__protonum">{d.stepNumber ?? ""}</span>
              <span className="decoded__prototext">{d.text};</span>
              {annotated ? (
                <span className="decoded__protonote">{d.description}</span>
              ) : (
                scan && <span className="decoded__protoscan">{scan.summary}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
