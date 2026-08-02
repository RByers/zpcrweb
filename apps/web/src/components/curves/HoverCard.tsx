import { useState } from "react";
import { createPortal } from "react-dom";
import { formatCq } from "@zpcrweb/core";

/** One row of a {@link HoverCard}: something on the plate (a well, a target/fluor, …) plus its
 * Cq. `selected` mirrors the chart's own dimming: false for a row excluded by a rail filter
 * (disabled well/channel/fluor/sample) — still listed, just greyed out, never actually plotted. */
export interface HoverCardRow {
  key: string;
  label: string;
  sublabel?: string;
  /** `null` is a curve that *has* no Cq (unamplified, or not computable) and reads as "—";
   * `undefined` is a curve Cq doesn't apply to at all — a channel-space curve, which is a raw
   * filter reading and never quantified (see `RunAnalysis.cqTable`) — and drops the column. */
  cq?: number | null;
  color?: string;
  selected: boolean;
}

/** Rows are shown selected-first, capped at this many, with a "N more" footer past the cap —
 * a fully-populated plate (96 wells) would otherwise make some cards unusably long. */
const MAX_ROWS = 10;

export interface HoverCardData {
  title: string;
  subtitle?: string;
  rows: HoverCardRow[];
  /** What to show in place of the rows when there are none. Defaults to the Curves view's
   * "No curves plotted"; the plate map, whose rows are a well's *contents* rather than plotted
   * curves, overrides it (see `PlateViewer`). */
  empty?: string;
}

/** Fixed-position portal card, positioned from the hovered chip/cell's own bounding rect — see
 * `FileBar.tsx`'s `HoverCard`, which this mirrors: the rail (`.curves__rail`) scrolls, so a plain
 * absolutely-positioned child would get clipped rather than floating over the chart. */
function HoverCard({
  anchor,
  data,
}: {
  anchor: { top: number; left: number; bottom: number };
  data: HoverCardData;
}) {
  return createPortal(
    <div
      className="curvecard mono"
      style={{ position: "fixed", top: anchor.bottom + 6, left: anchor.left, zIndex: 50 }}
    >
      <div className="curvecard__title">{data.title}</div>
      {data.subtitle && <div className="curvecard__subtitle">{data.subtitle}</div>}
      {data.rows.length > 0 ? (
        <>
          <div className="curvecard__rows">
            {data.rows.slice(0, MAX_ROWS).map((r) => (
              <div className={"curvecard__row" + (r.selected ? "" : " is-dim")} key={r.key}>
                {r.color && <span className="curvecard__swatch" style={{ background: r.color }} />}
                <span className="curvecard__label">{r.label}</span>
                {r.sublabel && <span className="curvecard__sub">{r.sublabel}</span>}
                {r.cq !== undefined && (
                  <span className="curvecard__cq">{formatCq(r.cq ?? null)}</span>
                )}
              </div>
            ))}
          </div>
          {data.rows.length > MAX_ROWS && (
            <div className="curvecard__more">{data.rows.length - MAX_ROWS} more</div>
          )}
        </>
      ) : (
        <div className="curvecard__empty">{data.empty ?? "No curves plotted"}</div>
      )}
    </div>,
    document.body,
  );
}

/** Wires a rail chip/cell's hover to a {@link HoverCard}: `show(key, el)` on mouse-enter looks up
 * the card's content via `dataFor` and positions it from `el`'s own bounding rect; `hide()` on
 * mouse-leave. Returns `node` to render (a no-op `null` when nothing is hovered) — a portal, so
 * where it's rendered in the tree doesn't matter. */
export function useHoverCard<K>(dataFor: (key: K) => HoverCardData | null | undefined) {
  const [state, setState] = useState<{
    anchor: { top: number; left: number; bottom: number };
    data: HoverCardData;
  } | null>(null);

  const show = (key: K, el: HTMLElement) => {
    const data = dataFor(key);
    if (!data) {
      setState(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setState({ anchor: { top: r.top, left: r.left, bottom: r.bottom }, data });
  };
  const hide = () => setState(null);
  const node = state ? <HoverCard anchor={state.anchor} data={state.data} /> : null;

  return { show, hide, node };
}
