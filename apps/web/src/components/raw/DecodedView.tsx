import { useMemo } from "react";
import { parseRunInfoRaw, type Zpcr } from "@zpcrweb/core";
import { DecodedPlateread } from "./DecodedPlateread";
import { DecodedPlate, PlateDetail } from "./DecodedPlate";
import { DecodedDcal } from "./DecodedDcal";
import { RunLogTable } from "./RunLogTable";
import { formatXml } from "../../lib/xmlFormat";

/** Which typed decoder (if any) applies to an archive entry. */
export type DecodedKind =
  | "plateread"
  | "plate"
  | "dcal"
  | "plate2"
  | "runinfo"
  | "runlog"
  | "protocol"
  | "xml"
  | null;

/** The one virtual entry name `.pcrd` uses for its already-decrypted `plateSetup2` subtree
 * (see `pcrd.ts`'s virtual archive) — routed to {@link EmbeddedPlate} instead of the
 * password-gated `.pltd` decoder, since a `.pcrd`'s plate needs no separate decryption. */
const PCRD_PLATE_NAME = "plateSetup2.xml";

export function decodedKind(name: string): DecodedKind {
  if (/\.Plateread$/i.test(name)) return "plateread";
  if (/\.pltd$/i.test(name)) return "plate";
  if (/\.dcal$/i.test(name)) return "dcal";
  if (name === PCRD_PLATE_NAME) return "plate2";
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
  if (kind === "plate2") return <EmbeddedPlate zpcr={zpcr} name={name} />;
  if (kind === "runinfo") return <RunInfoTable zpcr={zpcr} name={name} />;
  if (kind === "runlog") return <RunLogTable zpcr={zpcr} name={name} />;
  if (kind === "protocol") return <ProtocolDecoded zpcr={zpcr} name={name} />;
  if (kind === "xml") return <XmlDecoded zpcr={zpcr} name={name} />;

  return <div className="decoded__na mono">No decoder for this file.</div>;
}

/** The `plateSetup2` subtree of a `.pcrd` document — already decrypted along with the rest
 * of the document, so it renders straight through `zpcr.plates()` with no password step. */
function EmbeddedPlate({ zpcr, name }: Props) {
  const entry = zpcr.plates().find((p) => p.name === name);
  if (!entry?.pltd.plate) return <div className="decoded__na mono">No plate for {name}.</div>;
  return <PlateDetail plate={entry.pltd.plate} sourceHint="embedded in .pcrd document" />;
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

/** Leading setup directives that are not numbered protocol steps. */
const PROTOCOL_SETUP = /^(METHOD|HOTLID|VOLUME)\b/i;

/**
 * ProtocolRunDefinition is a `;`-separated program. Number the thermal steps 1-based
 * (skipping the METHOD/HOTLID/VOLUME setup directives) so `GOTO N,M` points exactly at
 * step N — e.g. `GOTO 2,44` → step 2.
 */
function ProtocolDecoded({ zpcr, name }: Props) {
  const text = zpcr.archive.text(name).trim();
  const lines = text
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

/** runlog.xml (and other XML): pretty-print with nesting + syntax highlighting. */
function XmlDecoded({ zpcr, name }: Props) {
  const text = zpcr.archive.text(name);
  const formatted = useMemo(() => formatXml(text), [text]);
  if (formatted == null) {
    return <pre className="decoded__xml mono">{text}</pre>;
  }
  return <div className="decoded__xml mono">{formatted}</div>;
}
