import type { SampleType } from "@zpcrweb/core";
import { wellKey } from "../../state/useZpcrStore";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import { useHoverCard, type HoverCardData } from "./HoverCard";

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
  /** Well keys holding at least one positive curve — one that crossed its threshold and so got a
   * Cq. Marked with a `+` in the cell, drawn in the well's own sample-type color (red for an NTC,
   * and so on) so the mark reads as part of the cell rather than as a separate legend. */
  positiveWells?: Set<string>;
  /** Hovering a well cell (by its `"A1"`-style label, or `null` on leave) — drives the
   * curve-chart highlight. */
  onHoverWell?: (label: string | null) => void;
  /** Double-clicking a well cell — isolates it: only this well stays enabled. */
  onSoloWell?: (row: number, col: number) => void;
  /** Hover-card content for a well's `"A1"`-style label, or `null`/undefined to show none. */
  cardData?: (label: string) => HoverCardData | null | undefined;
}

/**
 * 8×12 plate selection grid. Cells toggle a single well; the row letter (A–H) and column
 * number (1–12) headers toggle a whole row/column; the corner toggles all wells. The
 * reference row is shown separately, in the Reference view.
 */
export function WellMatrix({
  enabled,
  onChange,
  wellTypes,
  positiveWells,
  onHoverWell,
  onSoloWell,
  cardData,
}: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
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
        const positive = positiveWells?.has(key) ?? false;
        // The `+` takes the cell's border color, dimmed alongside it when the well is off, so a
        // positive NTC reads red and a positive unknown blue without needing a legend.
        const borderColor = meta ? meta.color + (on ? "" : "66") : undefined;
        return (
          <button
            key={`w${r}-${c}`}
            className={"wm-cell" + (on ? " is-on" : "")}
            style={
              meta
                ? {
                    borderColor,
                    background: meta.color + (on ? "40" : "16"),
                    boxShadow: on ? `0 0 6px ${meta.color}66` : undefined,
                  }
                : undefined
            }
            onClick={() => toggleWell(r, c)}
            onDoubleClick={() => onSoloWell?.(r, c)}
            onMouseEnter={(e) => {
              const wellLabel = `${label}${c + 1}`;
              onHoverWell?.(wellLabel);
              show(wellLabel, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHoverWell?.(null);
              hide();
            }}
            aria-pressed={on}
            aria-label={
              [`Well ${label}${c + 1}`, meta?.label, positive ? "positive" : null]
                .filter(Boolean)
                .join(" — ")
            }
            // Native tooltip only as a fallback: when a hover card is wired up it already names
            // the well and its sample type, and the two floating boxes fight each other.
            title={!cardData && meta ? `${label}${c + 1} — ${meta.label}` : undefined}
          >
            {positive && (
              <span className="wm-cell__plus" style={borderColor ? { color: borderColor } : undefined}>
                +
              </span>
            )}
          </button>
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
      {node}
    </div>
  );
}
