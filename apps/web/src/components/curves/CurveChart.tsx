import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { DarkCurve, TemperatureCurve } from "@zpcrweb/core";
import type {
  Baseline,
  BandsMode,
  CurveBaselineMode,
  CurveBaselineRange,
  Scale,
} from "../../state/useZpcrStore";
import { buildChart, type FactoryCurve, type PlotCurve, type TooltipData } from "../../lib/uplot/chart";
import { channelLabel } from "../../lib/channelColors";

interface Props {
  curves: PlotCurve[];
  darkCurves: DarkCurve[];
  /** Factory-calibration reference overlay (Reference view); empty draws none. */
  factoryCurves?: FactoryCurve[];
  /** Temperature series for the right-hand °C axis; empty hides that axis. */
  tempCurves: TemperatureCurve[];
  baseline: Baseline;
  /** Curves-view baseline algorithm (`threshold.md` §4); pass `"raw"` from the Reference view,
   * whose baselining is entirely factory-relative (`baseline` above). */
  curveBaselineMode: CurveBaselineMode;
  /** Manual baseline-region override (the rail's slider); pass `null` from the Reference view. */
  curveBaselineRange: CurveBaselineRange;
  scale: Scale;
  bands: BandsMode;
}

export function CurveChart({
  curves,
  darkCurves,
  factoryCurves = [],
  tempCurves,
  baseline,
  curveBaselineMode,
  curveBaselineRange,
  scale,
  bands,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [tip, setTip] = useState<TooltipData | null>(null);

  // (Re)build the plot whenever the data or options change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));

    const { data, options } = buildChart({
      wellCurves: curves,
      darkCurves,
      factoryCurves,
      tempCurves,
      baseline,
      curveBaselineMode,
      curveBaselineRange,
      scale,
      bands,
      width,
      height,
      onHover: setTip,
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);

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
    curveBaselineMode,
    curveBaselineRange,
    scale,
    bands,
  ]);

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
                    <td>{tip.mean.toFixed(1)}</td>
                  </tr>
                  <tr>
                    <td>min</td>
                    <td>{tip.min.toFixed(1)}</td>
                  </tr>
                  <tr>
                    <td>max</td>
                    <td>{tip.max.toFixed(1)}</td>
                  </tr>
                  <tr>
                    <td>std</td>
                    <td>{tip.std.toFixed(2)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
