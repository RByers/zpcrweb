import { useMemo } from "react";
import { parseRunInfoRaw, type Zpcr } from "@zpcrweb/core";
import { DecodedPlateread } from "./DecodedPlateread";
import { DecodedPlate } from "./DecodedPlate";
import { DecodedDcal } from "./DecodedDcal";
import { RunLogTable } from "./RunLogTable";
import { parseRunLog } from "../../lib/runlog";
import { XmlTreeFromString } from "../../lib/xmlTree";

/** Which typed decoder (if any) applies to an archive entry. Used for `.zpcr`'s real archive
 * entries only — a `.pcrd`'s document tree (`PcrdRawView`) dispatches on the real XML node it
 * represents instead, since it has no filenames to match against. */
export type DecodedKind =
  | "plateread"
  | "plate"
  | "dcal"
  | "runinfo"
  | "runlog"
  | "protocol"
  | "xml"
  | null;

export function decodedKind(name: string): DecodedKind {
  if (/\.Plateread$/i.test(name)) return "plateread";
  if (/\.pltd$/i.test(name)) return "plate";
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
    return <DecodedPlateread zpcr={zpcr} read={read} />;
  }

  if (kind === "plate") return <DecodedPlate zpcr={zpcr} name={name} />;
  if (kind === "dcal") return <DecodedDcal zpcr={zpcr} name={name} />;
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

/** Leading setup directives that are not numbered protocol steps. */
const PROTOCOL_SETUP = /^(METHOD|HOTLID|VOLUME)\b/i;

/**
 * A `;`-separated thermal protocol program (`.zpcr`'s real `ProtocolRunDefinition.txt`, or a
 * `.pcrd`'s `protocol2 runDefinition` attribute — same one-line format either way). Number the
 * thermal steps 1-based (skipping the METHOD/HOTLID/VOLUME setup directives) so `GOTO N,M`
 * points exactly at step N — e.g. `GOTO 2,44` → step 2.
 */
export function ProtocolDecoded({ text }: { text: string }) {
  const lines = text
    .trim()
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let stepNo = 0;
  return (
    <div className="decoded">
      <div className="decoded__proto mono">
        {lines.map((line, i) => {
          const setup = PROTOCOL_SETUP.test(line);
          const num = setup ? "" : String((stepNo += 1));
          return (
            <div
              key={i}
              className={"decoded__protoline" + (setup ? " is-setup" : "")}
            >
              <span className="decoded__protonum">{num}</span>
              <span>{line};</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
