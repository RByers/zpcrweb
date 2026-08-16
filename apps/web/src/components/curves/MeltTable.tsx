import { useState } from "react";
import { channelLabel, type MeltRow } from "@zpcrweb/core";
import { curveColor } from "../../lib/fluorColors";

interface Props {
  rows: MeltRow[];
  /** What the second column holds — "Channel", "Fluorophore" or "Target", following the View
   * toggle, the same way the chart's lines are labelled. */
  seriesLabel: string;
  /** Isolate one well and go back to the chart — the same affordance `CurveTable` offers. */
  onPickWell: (row: number, col: number) => void;
}

type SortKey = "well" | "series" | "tm" | "peakHeight";

/** The series a row belongs to, written out: its target, its fluorophore, or its channel —
 * whichever space the melt was analysed in and grouped by. */
function seriesOf(r: MeltRow): string {
  return r.target ?? r.dye ?? channelLabel(r.channel);
}

/** Plate position as one number, so Well sorts A1, A2, … B1 rather than A1, A10, A2. */
const wellOrder = (r: MeltRow) => r.row * 1000 + r.col;

function sortValue(r: MeltRow, key: SortKey): number | null {
  switch (key) {
    case "well":
      return wellOrder(r);
    case "series":
      return null; // a name, not a number — compared by `seriesOf` below
    case "tm":
      return r.tmC;
    case "peakHeight":
      return r.peakHeight;
  }
}

function SortArrow({ state }: { state: "asc" | "desc" | null }) {
  return <span className="atbl__arrow">{state === "asc" ? "▲" : state === "desc" ? "▼" : ""}</span>;
}

/**
 * Melt mode's table: one row per plotted curve, with the melting temperature it gave.
 *
 * The melt counterpart of `CurveTable`, and much smaller because a melt has far less to report —
 * no baseline, no threshold and no Cq (`melt.md` §1). A curve with no Tm still gets a row: "this
 * well melted at nothing" is a result, and dropping it would silently shorten the table.
 */
export function MeltTable({ rows, seriesLabel, onPickWell }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("well");
  const [dir, setDir] = useState<1 | -1>(1);

  const columns: readonly { key: SortKey; label: string; numeric?: boolean }[] = [
    { key: "well", label: "Well" },
    { key: "series", label: seriesLabel },
    { key: "tm", label: "Tm (°C)", numeric: true },
    { key: "peakHeight", label: "Peak (RFU/°C)", numeric: true },
  ];

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(1);
    }
  };

  const sorted = [...rows].sort((a, b) => {
    if (sortKey === "series") {
      return seriesOf(a).localeCompare(seriesOf(b)) * dir || wellOrder(a) - wellOrder(b);
    }
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    // A curve with no Tm sorts last whichever way the column points, the way a missing Cq does
    // in the analysis table — "no answer" is not a small answer.
    if (av == null && bv == null) return wellOrder(a) - wellOrder(b);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir || wellOrder(a) - wellOrder(b);
  });

  return (
    <table className="analysis__tbl runlog__tbl atbl">
      <thead>
        <tr>
          {columns.map((c) => {
            const state = c.key === sortKey ? (dir === 1 ? "asc" : "desc") : null;
            return (
              <th
                key={c.key}
                className={c.numeric ? "atbl__num" : undefined}
                aria-sort={
                  state === "asc" ? "ascending" : state === "desc" ? "descending" : "none"
                }
              >
                <button
                  type="button"
                  className={"atbl__sort" + (state ? " is-sorted" : "")}
                  onClick={() => toggle(c.key)}
                  title={`Sort by ${c.label}`}
                >
                  {c.label}
                  <SortArrow state={state} />
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => {
          // A dye-space row colors by its dye, a channel-space one by its channel — the same rule
          // the chart's lines follow, so a row and its line are the same color.
          const color = curveColor({ fluor: r.dye, channel: r.channel });
          return (
            <tr
              key={`${r.wellLabel}-${r.dye ?? r.channel}`}
              className={"analysis__row" + (r.tmC == null ? " is-nocq" : "")}
              style={{ "--rowc": color } as React.CSSProperties}
            >
              <td>
                <button
                  type="button"
                  className="atbl__pick"
                  onClick={() => onPickWell(r.row, r.col)}
                  title={`Chart well ${r.wellLabel} on its own`}
                >
                  <span className="atbl__well mono">{r.wellLabel}</span>
                </button>
              </td>
              <td>
                <span className="mono" style={{ color }}>
                  {seriesOf(r)}
                </span>
              </td>
              <td className="atbl__num mono">
                {r.tmC == null ? <span className="atbl__none">—</span> : r.tmC.toFixed(2)}
              </td>
              <td className="atbl__num mono">
                {r.peakHeight == null ? (
                  <span className="atbl__none">—</span>
                ) : (
                  r.peakHeight.toFixed(1)
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
