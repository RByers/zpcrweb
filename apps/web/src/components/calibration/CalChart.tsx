import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import {
  applyCalHighlight,
  buildCalChart,
  type CalHighlight,
  type CalPlotSeries,
  type CalSeriesMeta,
  type CalTooltipData,
} from "../../lib/uplot/calChart";
import { channelLabel } from "../../lib/channelColors";
import { formatRfu } from "../../lib/cq";
import type { Scale } from "../../state/useZpcrStore";

interface Props {
  series: CalPlotSeries[];
  /** The run's own block temperature, marked on the plot; `null` draws no marker. */
  runTemperatureC: number | null;
  scale: Scale;
  /** Rail-driven highlight (hovering a dye or channel chip); `null` shows every line fully. */
  highlight?: CalHighlight | null;
}

/**
 * uPlot host for the Calibration view — the same lifecycle as `CurveChart` (rebuild on data
 * change, cheap alpha-only redraw on hover, `ResizeObserver` for sizing) over `calChart.ts`'s
 * temperature-axis builder, and the same `.chart` CSS.
 */
export function CalChart({ series, runTemperatureC, scale, highlight = null }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const metaRef = useRef<CalSeriesMeta[]>([]);
  const [tip, setTip] = useState<CalTooltipData | null>(null);
  // Kept current on every render so the build effect can apply the live highlight without
  // depending on it — that dependency would rebuild the whole plot on every hover.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();

    const { data, options, meta } = buildCalChart({
      series,
      runTemperatureC,
      scale,
      width: Math.max(320, Math.floor(rect.width)),
      height: Math.max(240, Math.floor(rect.height)),
      onHover: setTip,
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);
    metaRef.current = meta;
    applyCalHighlight(plotRef.current, meta, highlightRef.current);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [series, runTemperatureC, scale]);

  useEffect(() => {
    if (plotRef.current) applyCalHighlight(plotRef.current, metaRef.current, highlight);
  }, [highlight]);

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
      {series.length === 0 && (
        <div className="chart__empty mono">
          Nothing selected — enable a calibration and a channel to plot response curves.
        </div>
      )}
      {tip && (
        <div className="chart__tip" style={{ left: tip.left, top: tip.top }} role="status">
          <div className="chart__tip-head">
            <span className="chart__tip-swatch" style={{ background: tip.color }} />
            <strong>{tip.dye}</strong>
            <span className="chart__tip-dye">
              {channelLabel(tip.channel)}
              {tip.primary ? " ★" : ""} · {tip.plateType}
            </span>
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>temp</td>
                <td>{tip.temperatureC.toFixed(1)} °C</td>
              </tr>
              <tr>
                {/* "interp" where this point sits on another file's temperature grid rather than
                    on one this file was measured at — the value is the algorithm's own linear
                    interpolation (calibration.md §3), not a reading. */}
                <td>{tip.measured ? "response" : "interp"}</td>
                <td>{formatRfu(tip.response)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
