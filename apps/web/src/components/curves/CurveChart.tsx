import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { DarkCurve, TemperatureCurve } from "@zpcrweb/core";
import type { Baseline, CurveView, Scale } from "../../state/useZpcrStore";
import {
  applyHighlight,
  buildChart,
  setThresholdLine,
  type FactoryCurve,
  type HighlightMatch,
  type PlotCurve,
  type SeriesMeta,
  type ThresholdLineState,
  type TooltipData,
} from "../../lib/uplot/chart";
import { channelLabel } from "../../lib/channelColors";
import { formatCq, formatRfu } from "../../lib/cq";

// Stable reference so the effect-dependency array below doesn't see a new "empty" array
// (and rebuild the whole chart, cancelling any in-progress hover) on every render.
const NO_FACTORY_CURVES: FactoryCurve[] = [];

interface Props {
  curves: PlotCurve[];
  darkCurves: DarkCurve[];
  /** Factory-calibration reference overlay (Reference view); empty draws none. */
  factoryCurves?: FactoryCurve[];
  /** Temperature series for the right-hand °C axis; empty hides that axis. */
  tempCurves: TemperatureCurve[];
  baseline: Baseline;
  /** Curves-view display mode (`threshold.md` §4); pass `"absolute"` from the Reference view,
   * whose baselining is entirely factory-relative (`baseline` above). */
  curveView: CurveView;
  /** Overlay each curve's auto-detected linear baseline at 50% opacity; pass `false` from the
   * Reference view. */
  drawBaseline: boolean;
  scale: Scale;
  /** Draw each curve's min/max envelope band; pass `false` from the Reference view. */
  bands: boolean;
  /** Rail-driven highlight (hovering a target/fluor chip or a well-grid cell); `null` shows
   * every curve at full opacity. */
  highlight?: HighlightMatch | null;
  /** Baseline-subtracted RFU to draw a dotted horizontal line at (hovering a target's threshold
   * row in the rail); `null`/`undefined` draws none. Meaningless outside `curveView: "relative"`
   * — see {@link ThresholdLineState}. */
  thresholdLine?: number | null;
}

export function CurveChart({
  curves,
  darkCurves,
  factoryCurves = NO_FACTORY_CURVES,
  tempCurves,
  baseline,
  curveView,
  drawBaseline,
  scale,
  bands,
  highlight = null,
  thresholdLine = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const metaRef = useRef<SeriesMeta[]>([]);
  const thresholdLineStateRef = useRef<ThresholdLineState | null>(null);
  const [tip, setTip] = useState<TooltipData | null>(null);
  // Kept current on every render (not just inside an effect) so the build effect below can
  // apply whatever highlight is active right now without depending on `highlight` itself —
  // that dependency would tear down and rebuild the whole uPlot instance on every hover.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const thresholdLineRef = useRef(thresholdLine);
  thresholdLineRef.current = thresholdLine;

  // (Re)build the plot whenever the data or options change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));

    const { data, options, meta, thresholdLineState } = buildChart({
      wellCurves: curves,
      darkCurves,
      factoryCurves,
      tempCurves,
      baseline,
      curveView,
      drawBaseline,
      scale,
      bands,
      width,
      height,
      onHover: setTip,
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);
    metaRef.current = meta;
    thresholdLineStateRef.current = thresholdLineState;
    applyHighlight(plotRef.current, meta, highlightRef.current);
    setThresholdLine(plotRef.current, thresholdLineState, thresholdLineRef.current ?? null);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [
    curves,
    darkCurves,
    factoryCurves,
    tempCurves,
    baseline,
    curveView,
    drawBaseline,
    scale,
    bands,
  ]);

  useEffect(() => {
    if (plotRef.current) applyHighlight(plotRef.current, metaRef.current, highlight);
  }, [highlight]);

  useEffect(() => {
    if (plotRef.current && thresholdLineStateRef.current) {
      setThresholdLine(plotRef.current, thresholdLineStateRef.current, thresholdLine ?? null);
    }
  }, [thresholdLine]);

  // Keep the plot sized to its container.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      plotRef.current?.setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(240, Math.floor(rect.height)),
      });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="chart">
      <div className="chart__host" ref={hostRef} />
      {curves.length === 0 && (
        <div className="chart__empty mono">
          No wells selected — enable channels and wells to plot curves.
        </div>
      )}
      {tip && (
        <div
          className="chart__tip"
          style={{ left: tip.left, top: tip.top }}
          role="status"
        >
          <div className="chart__tip-head">
            <span className="chart__tip-swatch" style={{ background: tip.color }} />
            <strong>{tip.kind === "dark" || tip.kind === "factory" ? tip.kind : tip.label}</strong>
            {tip.kind !== "temp" && (
              <span className="chart__tip-dye">
                {channelLabel(tip.channel)} · {tip.dye}
                {tip.kind === "factory" && ` · R${tip.col + 1}`}
              </span>
            )}
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>cycle</td>
                <td>{tip.cycle}</td>
              </tr>
              {tip.kind === "temp" ? (
                <tr>
                  <td>temp</td>
                  <td>{tip.mean.toFixed(2)} °C</td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td>mean</td>
                    <td>{formatRfu(tip.mean)}</td>
                  </tr>
                  <tr>
                    <td>min</td>
                    <td>{formatRfu(tip.min)}</td>
                  </tr>
                  <tr>
                    <td>max</td>
                    <td>{formatRfu(tip.max)}</td>
                  </tr>
                  <tr>
                    <td>std</td>
                    <td>{tip.std.toFixed(2)}</td>
                  </tr>
                  {tip.kind === "well" && tip.baselineFormula != null && (
                    <tr>
                      <td>baseline</td>
                      <td>{tip.baselineFormula}</td>
                    </tr>
                  )}
                  {tip.kind === "well" && tip.cq != null && (
                    <tr>
                      <td>Cq</td>
                      <td>{formatCq(tip.cq)}</td>
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
