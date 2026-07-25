import { useState } from "react";
import { friendlyTimestamp, type RunLogEntry, type RunLogParsed } from "../../lib/runlog";
import { XmlTreeFromString } from "../../lib/xmlTree";

const DEFAULT_COLUMNS = new Set(["TS", "Level", "Msg"]);

interface Props {
  parsed: RunLogParsed;
}

interface HoverState {
  index: number;
  x: number;
  y: number;
}

/** Renders a parsed run log — real `<Log>` (`.zpcr`) or `<log>` (`.pcrd`) records, already
 * shaped by `logEntriesFromElements`/`parseRunLog`/`summarizeRunLog` (`lib/runlog.ts`). */
export function RunLogTable({ parsed }: Props) {
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set([...DEFAULT_COLUMNS].filter((c) => parsed.columns.includes(c))),
  );
  const [hiddenSev, setHiddenSev] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<HoverState | null>(null);

  const shownColumns = parsed.columns.filter((c) => visibleCols.has(c));
  const rows = parsed.entries.filter(
    (e) => !hiddenSev.has(e.fields["Sev"] ?? ""),
  );

  const toggle = (set: Set<string>, key: string): Set<string> => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  };

  const cellText = (entry: RunLogEntry, col: string): string => {
    const v = entry.fields[col] ?? "";
    return col === "TS" ? friendlyTimestamp(v) : v;
  };

  const hoveredEntryIndex = hover ? parsed.entries.indexOf(rows[hover.index]!) : -1;

  return (
    <div className="runlog">
      <div className="runlog__controls">
        <div className="runlog__group">
          <span className="runlog__grouplabel">Columns</span>
          {parsed.columns.map((c) => (
            <button
              key={c}
              className={"runlog__chip" + (visibleCols.has(c) ? " is-on" : "")}
              onClick={() => setVisibleCols((s) => toggle(s, c))}
              aria-pressed={visibleCols.has(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {parsed.sevValues.length > 0 && (
          <div className="runlog__group">
            <span className="runlog__grouplabel">Severity</span>
            {parsed.sevValues.map((s) => (
              <button
                key={s}
                className={"runlog__chip" + (!hiddenSev.has(s) ? " is-on" : "")}
                onClick={() => setHiddenSev((h) => toggle(h, s))}
                aria-pressed={!hiddenSev.has(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <span className="runlog__count mono">
          {rows.length} / {parsed.entries.length} entries
        </span>
      </div>

      <div className="runlog__tblwrap" onMouseLeave={() => setHover(null)}>
        <table className="runlog__tbl mono">
          <thead>
            <tr>
              {shownColumns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((entry, i) => (
              <tr
                key={i}
                className={"runlog__row sev-" + (entry.fields["Sev"] ?? "").toLowerCase()}
                onMouseEnter={(e) => setHover({ index: i, x: e.clientX, y: e.clientY })}
                onMouseMove={(e) =>
                  setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))
                }
              >
                {shownColumns.map((c) => (
                  <td key={c} className={c === "TS" ? "runlog__ts" : ""}>
                    {cellText(entry, c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hover && hoveredEntryIndex >= 0 && (
        <div
          className="runlog__tip mono"
          style={{
            left: Math.min(hover.x + 16, window.innerWidth - 460),
            top: Math.min(hover.y + 16, window.innerHeight - 320),
          }}
        >
          <XmlTreeFromString xml={parsed.entries[hoveredEntryIndex]!.xml} />
        </div>
      )}
    </div>
  );
}
