import { useState } from "react";
import { createPortal } from "react-dom";

/** One row of a {@link HoverCard}: something plotted (a well, a target/fluor, …) plus its Cq. */
export interface HoverCardRow {
  key: string;
  label: string;
  sublabel?: string;
  cq: number | null;
  color?: string;
}

export interface HoverCardData {
  title: string;
  subtitle?: string;
  rows: HoverCardRow[];
}

/** Fixed-position portal card, positioned from the hovered chip/cell's own bounding rect — see
 * `FileBar.tsx`'s `HoverCard`, which this mirrors: the rail (`.curves__rail`) scrolls, so a plain
 * absolutely-positioned child would get clipped rather than floating over the chart. */
export function HoverCard({
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
        <table className="curvecard__tbl">
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td className="curvecard__swatch-cell">
                  {r.color && <span className="curvecard__swatch" style={{ background: r.color }} />}
                </td>
                <td className="curvecard__label">
                  {r.label}
                  {r.sublabel && <span className="curvecard__sub">{r.sublabel}</span>}
                </td>
                <td className="curvecard__cq">{r.cq != null ? r.cq.toFixed(2) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="curvecard__empty">No curves plotted</div>
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
