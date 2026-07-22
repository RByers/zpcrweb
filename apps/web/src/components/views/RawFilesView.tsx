import { useMemo, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";

type Mode = "hex" | "text";

function group(name: string): string {
  if (/\.Plateread$/i.test(name)) return "Plate reads";
  if (/\.Dcal$/i.test(name)) return "Calibration";
  if (/\.(xml|txt|alf)$/i.test(name)) return "Metadata";
  return "Other";
}

const GROUP_ORDER = ["Metadata", "Plate reads", "Calibration", "Other"];
const TEXTUAL = /\.(xml|txt|alf)$/i;

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
  const [mode, setMode] = useState<Mode>("hex");
  const [limit, setLimit] = useState(4096);

  const isTextual = TEXTUAL.test(selected);
  const size = selected ? zpcr.archive.bytes(selected).length : 0;

  const body = useMemo(() => {
    if (!selected) return "";
    if (mode === "text" && isTextual) return zpcr.archive.text(selected);
    return zpcr.archive.hexDump(selected, { maxBytes: limit });
  }, [zpcr, selected, mode, limit, isTextual]);

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
                onClick={() => {
                  setSelected(name);
                  setLimit(4096);
                }}
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
              className={"segmented__item" + (mode === "hex" ? " is-active" : "")}
              onClick={() => setMode("hex")}
            >
              Hex
            </button>
            <button
              className={"segmented__item" + (mode === "text" ? " is-active" : "")}
              onClick={() => setMode("text")}
              disabled={!isTextual}
              title={isTextual ? "" : "Binary file — hex only"}
            >
              Text
            </button>
          </div>
        </div>
        <pre className="raw__dump mono">{body}</pre>
        {mode === "hex" && limit < size && (
          <button className="raw__more" onClick={() => setLimit((l) => l + 8192)}>
            Show more ({(size - limit).toLocaleString()} B remaining)
          </button>
        )}
      </section>
    </div>
  );
}
