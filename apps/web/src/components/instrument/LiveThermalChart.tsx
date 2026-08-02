import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import {
  buildLiveThermalChart,
  liveThermalData,
  type LiveThermalTooltipData,
} from "../../lib/uplot/liveThermalChart";
import { elapsedLabel } from "../../lib/uplot/thermalChart";
import type { LiveThermalSample } from "../../state/useLiveThermalHistory";

/**
 * Block temperature against elapsed time for the run in progress, in the Instrument rail's Status
 * section — same uPlot lifecycle as `ThermalProfileChart` (rebuild on data change, `ResizeObserver`
 * for sizing), but fed a growing live series instead of a finished run's `.alf` profile.
 */
export function LiveThermalChart({ samples }: { samples: LiveThermalSample[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [tip, setTip] = useState<LiveThermalTooltipData | null>(null);

  const data = useMemo(() => liveThermalData(samples), [samples]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || samples.length === 0) return;
    const rect = host.getBoundingClientRect();

    const options = buildLiveThermalChart({
      width: Math.max(160, Math.floor(rect.width)),
      height: Math.max(100, Math.floor(rect.height)),
      onHover: setTip,
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [data]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      plotRef.current?.setSize({
        width: Math.max(160, Math.floor(rect.width)),
        height: Math.max(100, Math.floor(rect.height)),
      });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="chart thermal thermal--live">
      <div className="chart__host" ref={hostRef} />
      {samples.length === 0 && (
        <div className="chart__empty mono">Waiting for the first status reply…</div>
      )}
      {tip && (
        <div className="chart__tip" style={{ left: tip.left, top: tip.top }} role="status">
          <div className="chart__tip-head">
            <strong>{elapsedLabel(tip.atSeconds, true)}</strong>
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>block</td>
                <td>{tip.temperatureC.toFixed(1)} °C</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
