import { useEffect, useMemo, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";
import { DecodedView, decodedKind } from "../raw/DecodedView";
import { PlateXml } from "../raw/DecodedPlate";
import { ProtocolXml } from "../raw/DecodedProtocol";

type Mode = "decoded" | "text" | "hex";

function group(name: string): string {
  if (/\.Plateread$/i.test(name)) return "Plate reads";
  if (/\.pltd$/i.test(name)) return "Plate setup";
  if (/\.prcl$/i.test(name)) return "Protocol";
  if (/\.Dcal$/i.test(name)) return "Calibration";
  if (/\.(xml|txt|alf)$/i.test(name)) return "Metadata";
  return "Other";
}

const GROUP_ORDER = ["Metadata", "Plate setup", "Protocol", "Plate reads", "Calibration", "Other"];
const TEXTUAL = /\.(xml|txt|alf)$/i;

/** Best default mode for a file: decoded if a decoder exists, else text for text, else hex. */
function defaultMode(name: string): Mode {
  if (decodedKind(name)) return "decoded";
  if (TEXTUAL.test(name)) return "text";
  return "hex";
}

export function RawFilesView({ zpcr }: { zpcr: Zpcr }) {
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const name of zpcr.archive.entries) {
      const g = group(name);
      (map.get(g) ?? map.set(g, []).get(g)!).push(name);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      group: g,
      names: map.get(g)!,
    }));
  }, [zpcr]);

  const [selected, setSelected] = useState<string>(
    () => zpcr.archive.entries.find((n) => /RunInfo\.xml$/i.test(n)) ?? zpcr.archive.entries[0] ?? "",
  );
  const [mode, setMode] = useState<Mode>(() => defaultMode(selected));
  const [limit, setLimit] = useState(4096);

  // Reset to the file's best default mode whenever the selection changes.
  useEffect(() => {
    setMode(defaultMode(selected));
    setLimit(4096);
  }, [selected]);

  // `.pltd`/`.prcl` are usually binary (an encrypted ZIP), but their "Text" view is the
  // decrypted XML payload (or, for a plaintext `.prcl`, the raw runDefinition — see prcl.md
  // §1.1, handled inside <ProtocolXml> itself).
  const isPltd = /\.pltd$/i.test(selected);
  const isPrcl = /\.prcl$/i.test(selected);
  const isTextual = TEXTUAL.test(selected) || isPltd || isPrcl;
  const hasDecoded = decodedKind(selected) !== null;
  const size = selected ? zpcr.archive.bytes(selected).length : 0;

  const rawBody = useMemo(() => {
    if (!selected || mode === "decoded") return "";
    if (mode === "text" && (isPltd || isPrcl)) return ""; // rendered via <PlateXml>/<ProtocolXml>
    if (mode === "text" && isTextual) return zpcr.archive.text(selected);
    return zpcr.archive.hexDump(selected, { maxBytes: limit });
  }, [zpcr, selected, mode, limit, isTextual, isPltd, isPrcl]);

  return (
    <div className="raw">
      <aside className="raw__list">
        {groups.map((g) => (
          <div className="raw__group" key={g.group}>
            <div className="raw__grouphead">{g.group}</div>
            {g.names.map((name) => (
              <button
                key={name}
                className={"raw__item mono" + (name === selected ? " is-active" : "")}
                onClick={() => setSelected(name)}
                title={name}
              >
                {name}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="raw__viewer">
        <div className="raw__toolbar">
          <span className="raw__fname mono">{selected}</span>
          <span className="raw__size mono">{size.toLocaleString()} B</span>
          <div className="segmented segmented--sm raw__modes">
            <button
              className={"segmented__item" + (mode === "decoded" ? " is-active" : "")}
              onClick={() => setMode("decoded")}
              disabled={!hasDecoded}
              title={hasDecoded ? "" : "No decoder for this file"}
            >
              Decoded
            </button>
            <button
              className={"segmented__item" + (mode === "text" ? " is-active" : "")}
              onClick={() => setMode("text")}
              disabled={!isTextual}
              title={isPltd || isPrcl ? "Decrypted XML" : isTextual ? "" : "Binary file — hex only"}
            >
              {isPltd || isPrcl ? "XML" : "Text"}
            </button>
            <button
              className={"segmented__item" + (mode === "hex" ? " is-active" : "")}
              onClick={() => setMode("hex")}
            >
              Hex
            </button>
          </div>
        </div>

        {mode === "decoded" ? (
          <div className="raw__decoded">
            <DecodedView zpcr={zpcr} name={selected} />
          </div>
        ) : mode === "text" && isPltd ? (
          <div className="raw__decoded">
            <PlateXml zpcr={zpcr} name={selected} />
          </div>
        ) : mode === "text" && isPrcl ? (
          <div className="raw__decoded">
            <ProtocolXml zpcr={zpcr} name={selected} />
          </div>
        ) : (
          <>
            <pre className="raw__dump mono">{rawBody}</pre>
            {mode === "hex" && limit < size && (
              <button className="raw__more" onClick={() => setLimit((l) => l + 8192)}>
                Show more ({(size - limit).toLocaleString()} B remaining)
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
