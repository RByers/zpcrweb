import type { SampleType } from "@zpcrweb/core";
import { wellKey } from "../../state/useZpcrStore";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";

const ROWS = 8;
const COLS = 12;
const ROW_LETTERS = "ABCDEFGH";

interface Props {
  enabled: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Sample type per well key, from the plate definition — colors each cell to match the
   * Plates view (grey/empty, green/positive control, red/negative control, blue/unknown, …).
   * Omitted when no plate is loaded yet, in which case cells fall back to the plain on/off look. */
  wellTypes?: Map<string, SampleType>;
  /** Hovering a well cell (by its `"A1"`-style label, or `null` on leave) — drives the
   * curve-chart highlight. */
  onHoverWell?: (label: string | null) => void;
}

/**
 * 8×12 plate selection grid. Cells toggle a single well; the row letter (A–H) and column
 * number (1–12) headers toggle a whole row/column; the corner toggles all wells. The
 * reference row is shown separately, in the Reference view.
 */
export function WellMatrix({ enabled, onChange, wellTypes, onHoverWell }: Props) {
  const sampleKeys = () => {
    const keys: string[] = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) keys.push(wellKey(r, c));
    return keys;
  };

  const toggleWell = (r: number, c: number) => {
    const next = new Set(enabled);
    const k = wellKey(r, c);
    next.has(k) ? next.delete(k) : next.add(k);
    onChange(next);
  };

  const rowKeys = (r: number) => Array.from({ length: COLS }, (_, c) => wellKey(r, c));
  const colKeys = (c: number) => Array.from({ length: ROWS }, (_, r) => wellKey(r, c));

  const toggleGroup = (keys: string[]) => {
    const allOn = keys.every((k) => enabled.has(k));
    const next = new Set(enabled);
    for (const k of keys) (allOn ? next.delete(k) : next.add(k));
    onChange(next);
  };

  const toggleAll = () => {
    const keys = sampleKeys();
    const allOn = keys.every((k) => enabled.has(k));
    const next = new Set(enabled);
    for (const k of keys) (allOn ? next.delete(k) : next.add(k));
    onChange(next);
  };

  const renderRow = (r: number, label: string) => (
    <div className="wm-row" key={`row${r}`} style={{ display: "contents" }}>
      <button
        className="wm-head"
        onClick={() => toggleGroup(rowKeys(r))}
        title={`Toggle row ${label}`}
      >
        {label}
      </button>
      {Array.from({ length: COLS }, (_, c) => {
        const key = wellKey(r, c);
        const on = enabled.has(key);
        const type = wellTypes?.get(key);
        const meta = type ? SAMPLE_TYPE_META[type] : undefined;
        return (
          <button
            key={`w${r}-${c}`}
            className={"wm-cell" + (on ? " is-on" : "")}
            style={
              meta
                ? {
                    borderColor: meta.color + (on ? "" : "66"),
                    background: meta.color + (on ? "40" : "16"),
                    boxShadow: on ? `0 0 6px ${meta.color}66` : undefined,
                  }
                : undefined
            }
            onClick={() => toggleWell(r, c)}
            onMouseEnter={() => onHoverWell?.(`${label}${c + 1}`)}
            onMouseLeave={() => onHoverWell?.(null)}
            aria-pressed={on}
            aria-label={`Well ${label}${c + 1}`}
            title={meta ? `${label}${c + 1} — ${meta.label}` : undefined}
          />
        );
      })}
    </div>
  );

  return (
    <div className="wellmatrix" style={{ ["--cols" as string]: COLS }}>
      <button className="wm-corner" onClick={toggleAll} title="Toggle all wells">
        ⊕
      </button>
      {Array.from({ length: COLS }, (_, c) => (
        <button
          key={`col${c}`}
          className="wm-head"
          onClick={() => toggleGroup(colKeys(c))}
          title={`Toggle column ${c + 1}`}
        >
          {c + 1}
        </button>
      ))}

      {Array.from({ length: ROWS }, (_, r) => renderRow(r, ROW_LETTERS[r]!))}
    </div>
  );
}
