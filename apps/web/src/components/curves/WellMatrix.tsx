import { wellKey } from "../../state/useZpcrStore";

const ROWS = 8;
const COLS = 12;
const ROW_LETTERS = "ABCDEFGH";

interface Props {
  enabled: Set<string>;
  onChange: (next: Set<string>) => void;
}

/**
 * 8×12 plate selection grid. Cells toggle a single well; the row letter (A–H) and column
 * number (1–12) headers toggle a whole row/column; the corner toggles all wells. The
 * reference row is shown separately, in the Reference view.
 */
export function WellMatrix({ enabled, onChange }: Props) {
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
        const on = enabled.has(wellKey(r, c));
        return (
          <button
            key={`w${r}-${c}`}
            className={"wm-cell" + (on ? " is-on" : "")}
            onClick={() => toggleWell(r, c)}
            aria-pressed={on}
            aria-label={`Well ${label}${c + 1}`}
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
