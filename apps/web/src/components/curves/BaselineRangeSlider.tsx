interface Props {
  /** Cycle bounds (1-based, inclusive) the handles can move within. */
  min: number;
  max: number;
  /** Current begin/end cycle, always `begin <= end`. */
  value: [number, number];
  /** Whether `value` is an explicit override (vs. an auto-detected region shown for reference). */
  isManual: boolean;
  onChange: (value: [number, number]) => void;
  /** Clears the override back to auto-detection. */
  onReset: () => void;
}

/**
 * A double-ended cycle-range slider for the baseline region (`threshold.md` §3.1), built from
 * two overlaid native `<input type="range">` elements — each keeps its own keyboard/touch
 * handling and accessibility for free, and CSS makes only the thumbs (not the hidden tracks)
 * respond to pointer events so they don't fight each other.
 */
export function BaselineRangeSlider({ min, max, value, isManual, onChange, onReset }: Props) {
  const [begin, end] = value;

  const onBeginChange = (v: number) => onChange([Math.min(v, end), end]);
  const onEndChange = (v: number) => onChange([begin, Math.max(v, begin)]);

  return (
    <div className="baseline-range">
      <div className="baseline-range__head">
        <span className="rail__title" style={{ marginBottom: 0 }}>
          Baseline region
        </span>
        <button className="rail__link" onClick={onReset} disabled={!isManual}>
          auto
        </button>
      </div>
      <div className="baseline-range__track">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={begin}
          onChange={(e) => onBeginChange(Number(e.target.value))}
          aria-label="Baseline region start cycle"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={end}
          onChange={(e) => onEndChange(Number(e.target.value))}
          aria-label="Baseline region end cycle"
        />
        <div
          className="baseline-range__fill"
          style={{
            left: `${((begin - min) / (max - min || 1)) * 100}%`,
            right: `${100 - ((end - min) / (max - min || 1)) * 100}%`,
          }}
        />
      </div>
      <div className="baseline-range__value mono">
        cycles {begin}–{end}
        {!isManual && " (auto)"}
      </div>
    </div>
  );
}
