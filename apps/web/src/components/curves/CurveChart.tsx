import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import type { Baseline, CurveView, Scale } from "../../state/useZpcrStore";
import {
  applyHighlight,
  buildChart,
  hitTestCqMarker,
  setThresholdLine,
  thresholdAtPixel,
  type AuxAxis,
  type BuildChartConfig,
  type CqMarker,
  type FactoryCurve,
  type HighlightMatch,
  type PlotCurve,
  type PlotDarkCurve,
  type SeriesMeta,
  type ThresholdLineState,
  type TooltipData,
} from "../../lib/uplot/chart";
import { formatCq, formatRfu } from "@zpcrweb/core";
import { channelLabel } from "../../lib/channelColors";

// Stable reference so the effect-dependency array below doesn't see a new "empty" array
// (and rebuild the whole chart, cancelling any in-progress hover) on every render.
const NO_FACTORY_CURVES: FactoryCurve[] = [];

interface Props {
  curves: PlotCurve[];
  darkCurves: PlotDarkCurve[];
  /** Factory-calibration reference overlay (Reference view); empty draws none. */
  factoryCurves?: FactoryCurve[];
  /** Draw the factory lines; see `buildChart`'s `drawFactory`. Default true — the values stay
   * in `factoryCurves` either way, since the ΔRFU/Drift % baselines are computed from them. */
  drawFactory?: boolean;
  /** Overrides the x-axis presentation; see `buildChart`'s `xAxis`. */
  xAxis?: BuildChartConfig["xAxis"];
  /** What occupies the right-hand axis — temperatures or LED currents, never both (see
   * `rightAxis.ts`). An axis with no curves is hidden. */
  aux: AuxAxis;
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
  /** Also mark each highlighted curve's own baseline region and σ (hovering a single curve's row
   * in the rail's Threshold section) — see {@link ThresholdLineState.regions}. */
  thresholdRegions?: boolean;
  /** Grabbing a Cq ring; the caller reveals that curve's row in the rail's Threshold section. */
  onCqDragStart?: (target: CqDragTarget) => void;
  /**
   * Dragging a Cq ring up or down: `threshold` is where the pointer now sits, in the
   * baseline-corrected RFU the curve's threshold is expressed in. Supplying this is what makes the
   * rings draggable at all — without it they stay decorative, which is what the Reference view
   * wants.
   */
  onCqDrag?: (target: CqDragTarget, threshold: number) => void;
  /** The drag is over — released, or ended with Escape (which stops the drag where it is; the
   * threshold it set is an override like any other, undone with the row's own reset button). */
  onCqDragEnd?: () => void;
}

/** Which curve a dragged Cq ring belongs to — enough to key a per-curve threshold override
 * (`curveKey(row, col, fluor)`) and to name the well in the rail. */
export interface CqDragTarget {
  row: number;
  col: number;
  /** A per-curve threshold belongs to a well/fluorophore pair, so a curve with no fluorophore —
   * channel space — is never draggable. */
  fluor: string;
  wellLabel: string;
}

export function CurveChart({
  curves,
  darkCurves,
  factoryCurves = NO_FACTORY_CURVES,
  drawFactory = true,
  xAxis,
  aux,
  baseline,
  curveView,
  drawBaseline,
  scale,
  bands,
  highlight = null,
  thresholdLine = null,
  thresholdRegions = false,
  onCqDragStart,
  onCqDrag,
  onCqDragEnd,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const metaRef = useRef<SeriesMeta[]>([]);
  const cqMarkersRef = useRef<CqMarker[]>([]);
  const thresholdLineStateRef = useRef<ThresholdLineState | null>(null);
  const [tip, setTip] = useState<TooltipData | null>(null);
  // Kept current on every render (not just inside an effect) so the build effect below can
  // apply whatever highlight is active right now without depending on `highlight` itself —
  // that dependency would tear down and rebuild the whole uPlot instance on every hover.
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const thresholdLineRef = useRef(thresholdLine);
  thresholdLineRef.current = thresholdLine;
  const thresholdRegionsRef = useRef(thresholdRegions);
  thresholdRegionsRef.current = thresholdRegions;
  // Same reason as the highlight refs above, and one more: a Cq drag outlives the uPlot instance
  // it started on. Every move sets a threshold, which re-runs the analysis and rebuilds the whole
  // chart, so the drag has to read the *current* plot, meta and markers on each move rather than
  // closing over the ones it began with.
  const curvesRef = useRef(curves);
  curvesRef.current = curves;
  const cqHandlersRef = useRef({ onCqDragStart, onCqDrag, onCqDragEnd });
  cqHandlersRef.current = { onCqDragStart, onCqDrag, onCqDragEnd };
  /**
   * Whether a Cq drag is in progress — which is also the switch that takes the plot **out of the
   * mouse's way** for the duration (`suppressCursor` below).
   *
   * A drag is a gesture on one ring, but uPlot sees only a mouse moving across the plot: it tracks
   * the cursor, draws its vertical rule, puts a hover point on every series and feeds the tooltip.
   * Under a drag that whole apparatus is re-created on each frame along with the plot, so it
   * flickers, and it answers a question ("what is under the pointer?") nobody is asking while the
   * pointer is holding a handle.
   */
  const cqDraggingRef = useRef(false);
  /** Take the plot's hit-testing surface out of the mouse's way, or put it back. `pointerEvents:
   * none` rather than any uPlot cursor option, because it is the *whole* apparatus that has to
   * stop, and because it survives being re-applied to each rebuilt instance. */
  const suppressCursor = (on: boolean) => {
    const over = plotRef.current?.over;
    if (over) over.style.pointerEvents = on ? "none" : "";
  };

  // (Re)build the plot whenever the data or options change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(240, Math.floor(rect.height));

    const { data, options, meta, thresholdLineState, cqMarkers } = buildChart({
      wellCurves: curves,
      darkCurves,
      factoryCurves,
      drawFactory,
      xAxis,
      aux,
      baseline,
      curveView,
      drawBaseline,
      scale,
      bands,
      width,
      height,
      // A drag rebuilds the plot on every frame; a tooltip from before it started would sit there
      // through all of them, and the drag's own pointer must not raise a new one.
      onHover: (t) => setTip(cqDraggingRef.current ? null : t),
    });

    plotRef.current?.destroy();
    plotRef.current = new uPlot(options, data, host);
    // Each rebuilt instance comes with a live cursor of its own, so a drag has to re-suppress it —
    // otherwise the apparatus this is meant to silence comes back one frame later.
    if (cqDraggingRef.current) suppressCursor(true);
    metaRef.current = meta;
    cqMarkersRef.current = cqMarkers;
    thresholdLineStateRef.current = thresholdLineState;
    applyHighlight(plotRef.current, meta, highlightRef.current);
    setThresholdLine(
      plotRef.current,
      thresholdLineState,
      thresholdLineRef.current ?? null,
      thresholdRegionsRef.current,
    );

    return () => {
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [
    curves,
    darkCurves,
    factoryCurves,
    drawFactory,
    xAxis,
    aux,
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
      setThresholdLine(
        plotRef.current,
        thresholdLineStateRef.current,
        thresholdLine ?? null,
        thresholdRegions,
      );
    }
  }, [thresholdLine, thresholdRegions]);

  /**
   * Cq rings as drag handles: grab one and move the pointer up or down to set that one curve's
   * threshold, which moves the ring along its curve to the new crossing.
   *
   * Bound once, for the lifetime of the component rather than of a uPlot instance, since setting a
   * threshold rebuilds the plot (see `cqHandlersRef`) and a listener on the old instance would be
   * torn down mid-drag.
   *
   * `mousedown` is taken in the **capture** phase on the host, an ancestor of uPlot's own `.u-over`
   * listener, so grabbing a ring can `stopPropagation` and suppress uPlot's drag-to-zoom for that
   * gesture. On the `.u-over` element itself the two listeners would fire in registration order —
   * uPlot's first — whatever phase we asked for.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    /** The grabbed ring's curve, resolved afresh on every move: the rebuilds a drag causes can
     * reorder `curves` (a filter changing under it), so an index captured at grab time can't be
     * trusted, but a well/fluorophore pair identifies the curve for as long as it is plotted. */
    let dragging: CqDragTarget | null = null;
    let pendingTop: number | null = null;
    let frame = 0;

    const plotPos = (e: MouseEvent): { left: number; top: number } | null => {
      const u = plotRef.current;
      if (!u) return null;
      const rect = u.over.getBoundingClientRect();
      return { left: e.clientX - rect.left, top: e.clientY - rect.top };
    };

    /** The ring under the pointer, and the curve it belongs to — `null` unless that curve can
     * actually carry a per-curve threshold (dye space; see {@link CqDragTarget.fluor}). */
    const grabbable = (e: MouseEvent): CqDragTarget | null => {
      const u = plotRef.current;
      const pos = u && plotPos(e);
      if (!u || !pos) return null;
      const hit = hitTestCqMarker(u, cqMarkersRef.current, pos.left, pos.top);
      const curve = hit && curvesRef.current[hit.curveIndex];
      if (!curve?.fluor) return null;
      return {
        row: curve.row,
        col: curve.col,
        fluor: curve.fluor,
        wellLabel: curve.wellLabel,
      };
    };

    const apply = () => {
      frame = 0;
      const u = plotRef.current;
      const target = dragging;
      if (!u || !target || pendingTop == null) return;
      const meta = metaRef.current;
      const idx = meta.findIndex(
        (m) => m.kind === "well" && m.label === target.wellLabel && m.fluor === target.fluor,
      );
      if (idx === -1) return;
      const value = thresholdAtPixel(u, meta, idx, cqMarkersRef.current, pendingTop);
      if (value != null) cqHandlersRef.current.onCqDrag?.(target, value);
    };

    const onMove = (e: MouseEvent) => {
      const pos = plotPos(e);
      if (!pos) return;
      pendingTop = pos.top;
      // One threshold per frame: a move sets an override, which re-runs the run's analysis and
      // rebuilds the chart, and mouse moves arrive faster than that is worth doing.
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const onUp = () => stop();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stop();
    };

    const stop = () => {
      if (!dragging) return;
      dragging = null;
      cqDraggingRef.current = false;
      suppressCursor(false);
      pendingTop = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("is-cqdrag");
      cqHandlersRef.current.onCqDragEnd?.();
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !cqHandlersRef.current.onCqDrag) return;
      const target = grabbable(e);
      if (!target) return;
      // Both: `stopPropagation` keeps uPlot from starting a zoom selection, `preventDefault` keeps
      // the browser from starting a text selection that would follow the pointer across the page.
      e.stopPropagation();
      e.preventDefault();
      dragging = target;
      // Silence the plot's own cursor for the gesture, and clear whatever the hover that led to
      // this grab had already put on screen.
      cqDraggingRef.current = true;
      suppressCursor(true);
      setTip(null);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("keydown", onKey);
      document.body.classList.add("is-cqdrag");
      cqHandlersRef.current.onCqDragStart?.(target);
    };

    // Hover affordance: the ring is the only thing on the plot that can be grabbed, so it is the
    // only place the cursor changes. Left to uPlot's own cursor everywhere else.
    const onHoverMove = (e: MouseEvent) => {
      const u = plotRef.current;
      if (!u || dragging) return;
      const cursor = cqHandlersRef.current.onCqDrag && grabbable(e) ? "ns-resize" : "";
      if (u.over.style.cursor !== cursor) u.over.style.cursor = cursor;
    };

    host.addEventListener("mousedown", onDown, true);
    host.addEventListener("mousemove", onHoverMove);
    return () => {
      host.removeEventListener("mousedown", onDown, true);
      host.removeEventListener("mousemove", onHoverMove);
      stop();
    };
  }, []);

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
            {tip.kind !== "aux" && (
              <span className="chart__tip-dye">
                {channelLabel(tip.channel)} · {tip.dye}
                {tip.kind === "factory" && tip.col >= 0 && ` · R${tip.col + 1}`}
              </span>
            )}
          </div>
          <table className="chart__tip-tbl mono">
            <tbody>
              <tr>
                <td>{tip.xName}</td>
                <td>{tip.xText ?? tip.cycle}</td>
              </tr>
              {tip.kind === "aux" ? (
                <tr>
                  <td>{tip.rowLabel}</td>
                  <td>
                    {tip.mean.toFixed(tip.decimals ?? 1)} {tip.unit}
                  </td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td>mean</td>
                    <td>{formatRfu(tip.mean)}</td>
                  </tr>
                  {/* Spread rows only where there is real spread to report — channel space.
                      A color-separated curve is one solved concentration per cycle, so it has
                      no min/max/σ and these rows are omitted rather than shown as the mean. */}
                  {tip.min != null && (
                    <tr>
                      <td>min</td>
                      <td>{formatRfu(tip.min)}</td>
                    </tr>
                  )}
                  {tip.max != null && (
                    <tr>
                      <td>max</td>
                      <td>{formatRfu(tip.max)}</td>
                    </tr>
                  )}
                  {tip.std != null && (
                    <tr>
                      <td>std</td>
                      <td>{tip.std.toFixed(2)}</td>
                    </tr>
                  )}
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
