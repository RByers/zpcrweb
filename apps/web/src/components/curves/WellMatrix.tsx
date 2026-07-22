import { wellKey } from "../../state/useZpcrStore";

const ROWS = 8;
const COLS = 12;
const REF_ROW = 8;
const ROW_LETTERS = "ABCDEFGH";

interface Props {
  enabled: Set<string>;
  onChange: (next: Set<string>) => void;
}

/**
 * 8×12 plate selection grid plus a reference row (R). Cells toggle a single well; the row
 * letter (A–H, R) and column number (1–12) headers toggle a whole row/column; the corner
 * toggles all sample wells (A–H). The reference row is separate and off by default.
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
    // Preserve the reference row; only flip the sample wells.
    for (const k of keys) (allOn ? next.delete(k) : next.add(k));
    onChange(next);
  };

  const renderRow = (r: number, label: string, isRef: boolean) => (
    <div className="wm-row" key={`row${r}`} style={{ display: "contents" }}>
      <button
        className={"wm-head" + (isRef ? " wm-head--ref" : "")}
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
            className={"wm-cell" + (isRef ? " wm-cell--ref" : "") + (on ? " is-on" : "")}
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
      <button className="wm-corner" onClick={toggleAll} title="Toggle all sample wells">
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

      {Array.from({ length: ROWS }, (_, r) => renderRow(r, ROW_LETTERS[r]!, false))}
      {renderRow(REF_ROW, "R", true)}
    </div>
  );
}
