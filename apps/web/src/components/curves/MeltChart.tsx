import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import { formatRfu } from "@zpcrweb/core";
import {
  applyMeltHighlight,
  buildMeltChart,
  type MeltHighlight,
  type MeltPlotCurve,
  type MeltSeriesMeta,
  type MeltTooltipData,
} from "../../lib/uplot/meltChart";
import { channelLabel } from "../../lib/channelColors";
import type { MeltView } from "../../state/useZpcrStore";

interface Props {
  curves: MeltPlotCurve[];
  /** The melt's temperature axis, shared by every curve of the step. */
  temperaturesC: number[];
  view: MeltView;
  highlight?: MeltHighlight | null;
}

/**
 * The melt chart's host — the same shell `CurveChart` uses (a `ResizeObserver`-sized uPlot plus an
 * absolutely-positioned tooltip), minus the Cq drag machinery, which has no melt counterpart: a
 * melting temperature is where the curve is steepest, not a value anyone sets, so there is nothing
 * to drag it to.
 */
export function MeltChart({ curves, temperaturesC, view, highlight = null }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const metaRef = useRef<MeltSeriesMeta[]>([]);
  const [tip, setTip] = useState<MeltTooltipData | null>(null);
  // Kept current on every render so the build effect can apply whatever highlight is active now
  // without depending on it — that dependency would rebuild the whole plot on every hover.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const { data, options, meta } = buildMeltChart({
      curves,
      temperaturesC,
      view,
      width: Math.max(320, Math.floor(rect.width)),
      height: Math.max(240, Math.floor(rect.height)),
      onHover: setTip,
    });
    host.replaceChildren();
    const plot = new uPlot(options, data, host);
    plotRef.current = plot;
    metaRef.current = meta;
    if (highlightRef.current) applyMeltHighlight(plot, meta, highlightRef.current);
    return () => {
      plot.destroy();
      plotRef.current = null;
    };
  }, [curves, temperaturesC, view]);

  // Cheap redraw rather than a rebuild — see `applyMeltHighlight`.
  useEffect(() => {
    const plot = plotRef.current;
    if (plot) applyMeltHighlight(plot, metaRef.current, highlight);
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
      {curves.length === 0 && (
        <div className="chart__empty mono">
          No wells selected — enable channels and wells to plot melt curves.
        </div>
      )}
      {tip && (
        <div className="chart__tip" style={{ left: tip.left, top: tip.top }} role="status">
          <div className="chart__tip-head">
            <span className="chart__tip-swatch" style={{ background: tip.color }} />
            <strong>{tip.wellLabel}</strong>
            <span className="chart__tip-dye">{channelLabel(tip.channel)}</span>
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>temp</td>
                <td>{tip.temperatureC.toFixed(1)} °C</td>
              </tr>
              {/* Both forms, always: the plotted one is what the pointer is on, and the other is
                  the context that makes it readable — a derivative peak means little without the
                  fluorescence it came from. */}
              <tr>
                <td>−dF/dT</td>
                <td>{tip.derivative.toFixed(1)}</td>
              </tr>
              <tr>
                <td>RFU</td>
                <td>{formatRfu(tip.rfu)}</td>
              </tr>
              <tr>
                <td>Tm</td>
                <td>{tip.tmC == null ? "—" : `${tip.tmC.toFixed(2)} °C`}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
