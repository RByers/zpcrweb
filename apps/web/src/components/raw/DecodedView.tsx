import { useMemo } from "react";
import { parseRunInfoRaw, type Zpcr } from "@zpcrweb/core";
import { DecodedPlateread } from "./DecodedPlateread";
import { RunLogTable } from "./RunLogTable";
import { formatXml } from "../../lib/xmlFormat";

/** Which typed decoder (if any) applies to an archive entry. */
export type DecodedKind =
  | "plateread"
  | "runinfo"
  | "runlog"
  | "protocol"
  | "xml"
  | null;

export function decodedKind(name: string): DecodedKind {
  if (/\.Plateread$/i.test(name)) return "plateread";
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

  if (kind === "runinfo") return <RunInfoTable zpcr={zpcr} name={name} />;
  if (kind === "runlog") return <RunLogTable zpcr={zpcr} name={name} />;
  if (kind === "protocol") return <ProtocolDecoded zpcr={zpcr} name={name} />;
  if (kind === "xml") return <XmlDecoded zpcr={zpcr} name={name} />;

  return <div className="decoded__na mono">No decoder for this file.</div>;
}

/** RunInfo.xml is a flat list of KeyValuePairs — render it as a two-column table. */
function RunInfoTable({ zpcr, name }: Props) {
  const entries = useMemo(
    () => Object.entries(parseRunInfoRaw(zpcr.archive.text(name))),
    [zpcr, name],
  );
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

/** ProtocolRunDefinition is a `;`-separated program — break it onto one step per line. */
function ProtocolDecoded({ zpcr, name }: Props) {
  const text = zpcr.archive.text(name).trim();
  const lines = text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (
    <div className="decoded">
      {/* Zero-based line numbers so GOTO targets line up. */}
      <ol className="decoded__steps mono" start={0}>
        {lines.map((step, i) => (
          <li key={i}>{step};</li>
        ))}
      </ol>
    </div>
  );
}

/** runlog.xml (and other XML): pretty-print with nesting + syntax highlighting. */
function XmlDecoded({ zpcr, name }: Props) {
  const text = zpcr.archive.text(name);
  const formatted = useMemo(() => formatXml(text), [text]);
  if (formatted == null) {
    return <pre className="decoded__xml mono">{text}</pre>;
  }
  return <div className="decoded__xml mono">{formatted}</div>;
}
