import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { alfThermalProfile, type AlfReport } from "@zpcrweb/core";
import {
  buildThermalChart,
  elapsedLabel,
  type ThermalTooltipData,
} from "../../lib/uplot/thermalChart";

/**
 * What the block actually did, plotted: block temperature against wall-clock time, from the run's
 * `.alf` report (`alf.md` §7.6).
 *
 * This is the run's *measured* thermal history, not its protocol — the step list above it says a
 * 30 s hold at 60 °C, and this says that step really occupied 46 s, 16 of which the block spent
 * getting there. One solid line: the ramp is the sloped part and the hold the flat part, which
 * shows the same decomposition without splitting the temperature into two competing traces. Each
 * plate read is a numbered point, tying a cycle to a moment and a temperature.
 *
 * Same uPlot lifecycle as `CalChart`: rebuild on data change, `ResizeObserver` for sizing, and
 * the shared `.chart` CSS.
 */
export function ThermalProfileChart({ report }: { report: AlfReport }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [tip, setTip] = useState<ThermalTooltipData | null>(null);

  const profile = useMemo(() => alfThermalProfile(report), [report]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || profile.segments.length === 0) return;
    const rect = host.getBoundingClientRect();

    const { data, options } = buildThermalChart({
      profile,
      width: Math.max(320, Math.floor(rect.width)),
      height: Math.max(180, Math.floor(rect.height)),
      onHover: setTip,
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [profile]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      plotRef.current?.setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(180, Math.floor(rect.height)),
      });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const withHours = profile.totalSeconds >= 3600;

  return (
    <div className="chart thermal">
      <div className="chart__host" ref={hostRef} />
      {profile.segments.length === 0 && (
        <div className="chart__empty mono">
          The run report logs no step with a readable temperature.
        </div>
      )}
      {tip && (
        <div className="chart__tip" style={{ left: tip.left, top: tip.top }} role="status">
          <div className="chart__tip-head">
            <span
              className="chart__tip-swatch"
              style={{ background: PHASE_COLOR[tip.segment.phase] }}
            />
            <strong>{PHASE_LABEL[tip.segment.phase]}</strong>
            <span className="chart__tip-dye">
              {elapsedLabel(tip.atSeconds, withHours)}
              {tip.readIndex !== undefined ? ` · read ${tip.readIndex}` : ""}
            </span>
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>block</td>
                <td>
                  {tip.temperatureC.toFixed(1)} °C
                  {tip.segment.gradient && (
                    <span className="chart__tip-note">
                      {" "}
                      ({tip.segment.gradient.lowC}–{tip.segment.gradient.highC})
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <td>step</td>
                <td>
                  {tip.segment.step.stepNumber}
                  <span className="chart__tip-note"> · rep {tip.segment.step.repeat}</span>
                </td>
              </tr>
              <tr>
                <td>hold</td>
                <td>{secondsLabel(tip.segment.step.holdSeconds)}</td>
              </tr>
              <tr>
                {/* The wall time the step occupied — the number the report never states and this
                    plot exists to show (alf.md §7.4). */}
                <td>took</td>
                <td>{secondsLabel(tip.segment.step.elapsedSeconds)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const PHASE_LABEL = {
  ramp: "Ramp",
  hold: "Hold",
  read: "Plate read",
} as const;

/**
 * The trace is one line in one colour (see `thermalChart.ts`), so the swatch only distinguishes
 * the plate reads, which are drawn as their own points; ramp and hold are the same line and get
 * the same colour, with the tooltip's label carrying the difference.
 */
const PHASE_COLOR = {
  ramp: "#22d3ee",
  hold: "#22d3ee",
  read: "#ff4fa3",
} as const;

function secondsLabel(seconds: number | null | undefined): string {
  return seconds == null ? "—" : `${seconds} s`;
}
