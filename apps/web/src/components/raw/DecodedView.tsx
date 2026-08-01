import { useMemo } from "react";
import { parseRunDefinition, parseRunInfoRaw, type Zpcr } from "@zpcrweb/core";
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
 */
export function ProtocolDecoded({ text }: { text: string }) {
  const program = useMemo(() => parseRunDefinition(text), [text]);
  return (
    <div className="decoded">
      <div className="decoded__proto mono">
        {program.directives.map((d) => (
          <div
            key={d.index}
            className={"decoded__protoline" + (d.stepNumber === undefined ? " is-setup" : "")}
          >
            <span className="decoded__protonum">{d.stepNumber ?? ""}</span>
            <span className="decoded__prototext">{d.text};</span>
            <span className="decoded__protonote">{d.description}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
