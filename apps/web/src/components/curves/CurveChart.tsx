import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { DarkCurve, WellCurve } from "@zpcrweb/core";
import type { Baseline, Scale } from "../../state/useZpcrStore";
import { buildChart, type TooltipData } from "../../lib/uplot/chart";

interface Props {
  curves: WellCurve[];
  darkCurves: DarkCurve[];
  baseline: Baseline;
  scale: Scale;
  subtractDark: boolean;
}

export function CurveChart({ curves, darkCurves, baseline, scale, subtractDark }: Props) {
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
      baseline,
      scale,
      subtractDark,
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
  }, [curves, darkCurves, baseline, scale, subtractDark]);

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
            <strong>{tip.kind === "dark" ? "dark" : tip.label}</strong>
            <span className="chart__tip-dye">
              C{tip.channel + 1} · {tip.dye}
            </span>
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>cycle</td>
                <td>{tip.cycle}</td>
              </tr>
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
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
