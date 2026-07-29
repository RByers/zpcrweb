import { useState } from "react";
import { DEFAULT_THRESHOLD_MULTIPLIER } from "../../state/useZpcrStore";
import { ResetIcon } from "../ResetIcon";

/** One curve — a single well/fluorophore pair — under its fluorophore in the threshold list. */
export interface ThresholdCurveRow {
  /** `curveKey(row, col, fluor)`: the key a per-curve override is filed under. */
  key: string;
  wellLabel: string;
  /** The cycle range this curve's own baseline-region auto-detection settled on (`threshold.md`
   * §3) — per-curve, so two wells of one dye routinely differ. */
  beginCycle: number;
  endCycle: number;
  /** §5.1's median-absolute-second-difference noise estimate: this curve's contribution to the
   * group median. */
  noise: number;
  /** The whole corrected curve sits above this curve's threshold, so no crossing exists — see
   * `threshold.md` §6. */
  aboveThreshold: boolean;
  /** The threshold this curve's Cq was actually taken against. */
  threshold: number;
  /** Its own override, when it has one — what makes it differ from the group's threshold. */
  override: number | undefined;
}

/** One fluorophore's threshold row, plus the curves it was derived from. */
export interface ThresholdGroupRow {
  fluor: string;
  /** The optical channel this dye is read on — what a hover highlights in channel space, where
   * there is no dye-space curve to isolate. */
  channel: number | undefined;
  /** The group's threshold: its override, or §5.1's auto value. Independent of any per-curve
   * override, which replaces the number a single curve uses without moving the group. */
  threshold: number | undefined;
  override: number | undefined;
  curves: ThresholdCurveRow[];
}

interface Props {
  groups: ThresholdGroupRow[];
  multiplier: number;
  onMultiplierChange: (value: number) => void;
  /** `raw` empty clears the override, putting the fluorophore back on its auto threshold. */
  onGroupOverride: (fluor: string, raw: string) => void;
  /** `raw` empty clears the override, putting the curve back on its group's threshold. */
  onCurveOverride: (curveKey: string, raw: string) => void;
  /** Hovering a fluorophore's row: isolate its curves and mark its threshold. `null` on leave. */
  onHoverGroup: (group: ThresholdGroupRow | null) => void;
  /** Hovering one curve's row: isolate that curve and mark its threshold *and* its baseline
   * region/noise — the diagnostic only makes sense one curve at a time. */
  onHoverCurve: (group: ThresholdGroupRow, curve: ThresholdCurveRow) => void;
}

/**
 * The Curves rail's Threshold section: §5.1's auto-threshold multiplier, then one row per
 * fluorophore — expandable to the individual curves behind it.
 *
 * Both levels are editable, and a per-curve override wins (see
 * `CqTableOptions.curveThresholdOverrides`). The nesting is the explanation: a fluorophore's
 * threshold is a median over exactly the curves listed under it, each with its own baseline region
 * and noise, so the row that looks wrong and the number to fix it are in the same place. An
 * overridden field is tinted, so a manual value never reads as something the run computed.
 *
 * This replaced a hover card that listed every contributing well: the same information, but
 * transient, read-only, and long enough to run off the screen on a full plate.
 */
export function ThresholdSection({
  groups,
  multiplier,
  onMultiplierChange,
  onGroupOverride,
  onCurveOverride,
  onHoverGroup,
  onHoverCurve,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (fluor: string) => {
    const next = new Set(expanded);
    next.has(fluor) ? next.delete(fluor) : next.add(fluor);
    setExpanded(next);
  };

  return (
    <>
      {/* §5.1's `k` in `threshold = k × median baseline noise`. Adjustable because the calibrated
          default rests on two anchors from a single run (see `AutoThresholdOptions.multiplier`),
          and because it is the one number that moves every Cq on the plate — the per-group
          thresholds below update live as it moves, so its effect is visible rather than inferred.
          Overridden groups and curves ignore it. */}
      <div className="threshold-k">
        <div className="threshold-k__head">
          <span>Auto threshold</span>
          <span className="threshold-k__value mono">{multiplier}× noise</span>
        </div>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={multiplier}
          aria-label="Auto-threshold multiplier, in multiples of median baseline noise"
          onChange={(e) => onMultiplierChange(Number(e.currentTarget.value))}
        />
        <div className="threshold-k__foot">
          <span className="threshold-k__hint mono">Default {DEFAULT_THRESHOLD_MULTIPLIER}×</span>
          <button
            type="button"
            className="rail__link"
            disabled={multiplier === DEFAULT_THRESHOLD_MULTIPLIER}
            onClick={() => onMultiplierChange(DEFAULT_THRESHOLD_MULTIPLIER)}
          >
            Reset
          </button>
        </div>
      </div>

      {/* Keyed by fluorophore, not target: a threshold is derived from baseline noise, which is a
          property of the dye and the optics rather than of the biological label on the well — see
          `RunAnalysis.thresholdGroupOf`. */}
      <div className="analysis__thresholds">
        {groups.map((g) => {
          const isOpen = expanded.has(g.fluor);
          const isAuto = g.override === undefined;
          // The field always carries a value — the live auto threshold when there's no override —
          // rather than sitting empty behind a placeholder. An empty number input steps from 0, so
          // one press of the down arrow used to jump the threshold from (say) 210 to
          // nothing-or-zero; seeded this way the arrows nudge from where the threshold actually is.
          // Whole RFU only: a threshold is a level on a curve running to thousands, and sub-unit
          // steps are below anything the reading means.
          const shown = isAuto ? (g.threshold != null ? Math.round(g.threshold) : "") : g.override;
          return (
            <div key={g.fluor} className="analysis__threshold-group">
              <div
                className="analysis__threshold-row mono"
                onMouseEnter={() => onHoverGroup(g)}
                onMouseLeave={() => onHoverGroup(null)}
              >
                <button
                  type="button"
                  className="analysis__threshold-chevron"
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Hide" : "Show"} the curves behind ${g.fluor}'s threshold`}
                  title={`${isOpen ? "Hide" : "Show"} the ${g.curves.length} curves behind this threshold`}
                  disabled={g.curves.length === 0}
                  onClick={() => toggle(g.fluor)}
                >
                  <span className={"rail__chevron" + (isOpen ? " is-open" : "")} aria-hidden="true">
                    ▸
                  </span>
                </button>
                <span>{g.fluor}</span>
                <input
                  type="number"
                  step={1}
                  value={shown}
                  className={isAuto ? "is-auto" : "is-override"}
                  aria-label={`${g.fluor} threshold in RFU`}
                  onChange={(e) => onGroupOverride(g.fluor, e.currentTarget.value)}
                />
                <button
                  type="button"
                  className="rail__link rail__icon-btn"
                  disabled={isAuto}
                  aria-label={`Reset ${g.fluor} to its automatic threshold`}
                  title={`Reset ${g.fluor} to its automatic threshold`}
                  onClick={() => onGroupOverride(g.fluor, "")}
                >
                  <ResetIcon />
                </button>
              </div>
              {isOpen &&
                g.curves.map((c) => {
                  const curveAuto = c.override === undefined;
                  const curveShown = curveAuto ? Math.round(c.threshold) : c.override;
                  return (
                    <div
                      key={c.key}
                      className="analysis__threshold-row analysis__threshold-row--curve mono"
                      onMouseEnter={() => onHoverCurve(g, c)}
                      onMouseLeave={() => onHoverGroup(null)}
                    >
                      <span className="analysis__threshold-well">{c.wellLabel}</span>
                      {/* The two numbers a threshold is actually made of, per curve: the cycles its
                          baseline was fitted over, and the noise that came out of them. */}
                      <span
                        className="analysis__threshold-region"
                        title={
                          c.aboveThreshold
                            ? "Baseline region (cycles) — the whole corrected curve sits above this threshold, so it never crosses"
                            : "Baseline region (cycles)"
                        }
                      >
                        {c.beginCycle}&ndash;{c.endCycle}
                        {c.aboveThreshold ? " ⚠" : ""}
                      </span>
                      <span className="analysis__threshold-noise" title="Baseline noise (σ)">
                        σ{c.noise.toFixed(1)}
                      </span>
                      <input
                        type="number"
                        step={1}
                        value={curveShown}
                        className={curveAuto ? "is-auto" : "is-override"}
                        aria-label={`${g.fluor} threshold in RFU for well ${c.wellLabel}`}
                        onChange={(e) => onCurveOverride(c.key, e.currentTarget.value)}
                      />
                      <button
                        type="button"
                        className="rail__link rail__icon-btn"
                        disabled={curveAuto}
                        aria-label={`Reset well ${c.wellLabel} to ${g.fluor}'s threshold`}
                        title={`Reset well ${c.wellLabel} to ${g.fluor}'s threshold`}
                        onClick={() => onCurveOverride(c.key, "")}
                      >
                        <ResetIcon />
                      </button>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </>
  );
}
