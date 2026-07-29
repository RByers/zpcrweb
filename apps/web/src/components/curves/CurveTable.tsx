import { useMemo, useState } from "react";
import type { AnalysisRow } from "../../lib/analysisRows";
import { channelColor, channelLabel } from "../../lib/channelColors";
import { formatCq, formatRfu } from "../../lib/cq";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";

interface Props {
  rows: AnalysisRow[];
  /** Cycles read in the active step — the domain the Cq axis spans. 0 when unknown, which drops
   * the axis and leaves the number alone. */
  cycleCount: number;
  /** Whether the plate assigns targets at all — when it doesn't, the group *is* the fluorophore
   * and the Target column would just repeat the Fluor one. */
  usingTargets: boolean;
}

/** The columns that can be sorted on, i.e. all of them. */
type SortKey =
  | "well"
  | "sample"
  | "sampleType"
  | "fluor"
  | "target"
  | "baseline"
  | "threshold"
  | "cq"
  | "deltaRfu";

interface Column {
  key: SortKey;
  label: string;
  /** Right-aligned. Alignment only — what a column sorts *by* comes from the value's own type
   * (see {@link sortRows}), not from this. */
  numeric?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: "well", label: "Well" },
  { key: "sample", label: "Sample" },
  { key: "sampleType", label: "Type" },
  { key: "fluor", label: "Fluor" },
  { key: "target", label: "Target" },
  { key: "baseline", label: "Baseline" },
  { key: "threshold", label: "Threshold", numeric: true },
  { key: "cq", label: "Cq", numeric: true },
  { key: "deltaRfu", label: "ΔRFU", numeric: true },
];

/** Plate position as one number — so Well sorts A1, A2, … B1 rather than by label text, which
 * would put A10 before A2. */
const wellOrder = (r: AnalysisRow) => r.row * 1000 + r.col;

/** The value a column sorts on. Strings compare with `localeCompare`, numbers numerically; a
 * missing Cq is null and gets the special handling in {@link sortRows}. */
function sortValue(r: AnalysisRow, key: SortKey): string | number | null {
  switch (key) {
    case "well":
      return wellOrder(r);
    case "sample":
      return r.sample;
    case "sampleType":
      return SAMPLE_TYPE_META[r.sampleType].label;
    case "fluor":
      return r.fluor;
    case "target":
      return r.target;
    case "baseline":
      return r.baselineFormula;
    case "threshold":
      return r.threshold;
    case "cq":
      return r.cq;
    case "deltaRfu":
      return r.deltaRfu;
  }
}

/**
 * Rows in the order a given header click asks for, with two rules on top of the comparison
 * itself: sorting by Cq parks the wells that have none at the bottom in *both* directions (an
 * unquantified well is never the headline of the table), and plate position is the final
 * tiebreak everywhere, so equal values keep the stable A1→H12 order the rest of the app reads in.
 *
 * Numbers compare numerically and strings with `localeCompare`, chosen from the value rather
 * than from `Column.numeric` — that flag is about alignment, and Well is the case where the two
 * disagree: it's a left-aligned column sorted on a position number, and comparing that as text
 * would order B3 before A3.
 */
function sortRows(rows: AnalysisRow[], key: SortKey, dir: 1 | -1): AnalysisRow[] {
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av == null || bv == null) {
      // Only Cq is ever null; those rows park at the bottom regardless of direction.
      if (av != null) return -1;
      if (bv != null) return 1;
    } else if (typeof av === "number" && typeof bv === "number") {
      const d = av - bv;
      if (d) return d * dir;
    } else {
      const d = String(av).localeCompare(String(bv));
      if (d) return d * dir;
    }
    return wellOrder(a) - wellOrder(b);
  });
}

/** ▲/▼ on the active column, a faint ↕ on the rest — the placeholder keeps header widths from
 * jumping as the sort moves, and advertises that the other columns sort too. */
function SortArrow({ state }: { state: "asc" | "desc" | null }) {
  return (
    <span className={"atbl__arrow" + (state ? " is-on" : "")} aria-hidden="true">
      {state === "asc" ? "▲" : state === "desc" ? "▼" : "↕"}
    </span>
  );
}

/**
 * A value chip tinted by one colour: that hue for the text and border, a dilute wash of it
 * behind. A single `--c` custom property drives all three (see `.atbl__chip` in app.css), so a
 * chip stays one colour decision.
 *
 * The hues are borrowed, never invented — the optical-channel palette for Fluor/Target (so a
 * row matches the curve the chart draws for it) and `SAMPLE_TYPE_META` for Type (so it matches
 * the plate map's well).
 */
function ValueChip({
  color,
  children,
  title,
  mono = true,
}: {
  color: string;
  children: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={"atbl__chip" + (mono ? " mono" : "")}
      style={{ "--c": color } as React.CSSProperties}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * Cq as a position on the run's cycle axis, not just a number: a track spanning cycle 1 → the
 * last cycle read, with a marker where this well crossed its threshold.
 *
 * This is the axis the chart's x already uses, so the cue reads as "when did it cross" rather
 * than as an abstract score — early crossers cluster left, and sorting by Cq lines the markers up
 * into a diagonal. It's position rather than hue on purpose: the table already spends colour on
 * the optical channel and on the sample type, and a green→red Cq ramp would assert a verdict the
 * app has no basis for (whether "late" is bad depends on the assay and on a threshold the user
 * sets, and a Cq only compares within a target anyway). The axis is absolute — a measurement, not
 * a judgement — so it stays honest across targets.
 *
 * The number itself carries the same signal redundantly, as brightness: earlier is brighter,
 * along the existing `--ink` → `--ink-muted` ramp, which puts "late but real" and "never crossed"
 * on one continuum instead of a cliff. A well with no Cq keeps its empty track — the axis showing
 * nothing on it is the point.
 */
function CqCell({ cq, cycleCount, color }: { cq: number | null; cycleCount: number; color: string }) {
  const t = cq != null && cycleCount > 1 ? clamp01((cq - 1) / (cycleCount - 1)) : null;
  return (
    <span className="atbl__cqcell">
      <span
        className={"atbl__cq mono" + (cq == null ? " is-none" : "")}
        // Brightness falls off with the cycle at which it crossed. Computed here rather than in
        // CSS: the ramp is over the run's own cycle count, which only this component knows.
        style={t == null ? undefined : { color: `color-mix(in srgb, var(--ink) ${cqInk(t)}%, var(--ink-muted))` }}
      >
        {formatCq(cq)}
      </span>
      {cycleCount > 1 && (
        <span
          className="atbl__cqaxis"
          title={cq == null ? `No Cq in ${cycleCount} cycles` : `Cq ${formatCq(cq)} of ${cycleCount} cycles`}
        >
          {t != null && (
            <span className="atbl__cqmark" style={{ left: `${t * 100}%`, background: color }} />
          )}
        </span>
      )}
    </span>
  );
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** How much `--ink` (vs. `--ink-muted`) a Cq's text keeps, from a crossing at cycle 1 to one at
 * the last cycle. Stops well short of 0 so the latest Cq is still dimmer-but-legible rather than
 * lost — it's a real measurement, only a weaker one. */
const cqInk = (t: number) => Math.round(100 - t * 65);

/**
 * The Curves view's table mode: the run's Cq/ΔRFU table, in place of the chart. Every value is
 * looked up in the run's one Cq table upstream (see `lib/analysisRows.ts`) — this component only
 * orders and paints them.
 *
 * Every header sorts: click to sort by that column, click again to reverse. The sort is local
 * state rather than a URL or settings key, since it's a way of reading the table rather than a
 * property of the run — nothing else in the app depends on it.
 *
 * Colour is borrowed rather than invented: Fluor and Target chips take the optical-channel hue
 * their curve is drawn in, and each row is washed with its well's sample-type colour — the same
 * one the plate map paints that well — so the controls stand out from the unknowns at a glance.
 * Magnitude is spent on position instead: Cq sits on the run's cycle axis (see {@link CqCell})
 * and ΔRFU on a bar scaled to the whole table.
 *
 * A row with no Cq renders greyed out (`.is-unamplified`) rather than being hidden, so a well
 * disqualified by the §7 baseline gate or the amplification squelch stays visible instead of
 * silently vanishing from the table.
 */
export function CurveTable({ rows, usingTargets, cycleCount }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("target");
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => sortRows(rows, sortKey, dir), [rows, sortKey, dir]);
  /** Scale for the ΔRFU bars: the largest endpoint in the whole table, so bar lengths compare
   * across rows and don't rescale when the sort changes. */
  const maxDelta = useMemo(
    () => rows.reduce((m, r) => Math.max(m, Math.abs(r.deltaRfu)), 0),
    [rows],
  );

  if (rows.length === 0) {
    return (
      <div className="chart__empty mono">
        No target/well combinations selected — enable targets and wells to populate the table.
      </div>
    );
  }

  const columns = COLUMNS.filter((c) => c.key !== "target" || usingTargets);
  const toggle = (key: SortKey) => {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setDir(1);
    }
  };

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
                aria-sort={state === "asc" ? "ascending" : state === "desc" ? "descending" : "none"}
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
          const color = channelColor(r.channel);
          const typeMeta = SAMPLE_TYPE_META[r.sampleType];
          return (
            <tr
              key={`${r.target}-${r.wellLabel}-${r.fluor}`}
              className={"analysis__row" + (r.cq == null ? " is-unamplified" : "")}
              // The row's wash and the Well chip both read `--rowc` (see `.atbl` in app.css).
              style={{ "--rowc": typeMeta.color } as React.CSSProperties}
            >
              <td>
                <span className="atbl__well mono">{r.wellLabel}</span>
              </td>
              <td>{r.sample || <span className="atbl__none">—</span>}</td>
              <td>
                <ValueChip color={typeMeta.color} mono={false} title={r.sampleType}>
                  {typeMeta.label}
                </ValueChip>
              </td>
              <td>
                <ValueChip color={color} title={`Read on ${channelLabel(r.channel)}`}>
                  <span className="atbl__swatch" />
                  {r.fluor}
                </ValueChip>
              </td>
              {usingTargets && (
                <td>
                  <ValueChip color={color} mono={false}>
                    {r.target}
                  </ValueChip>
                </td>
              )}
              <td className="mono atbl__baseline">{r.baselineFormula}</td>
              <td className="mono atbl__num">{formatRfu(r.threshold)}</td>
              <td className="atbl__num">
                <CqCell cq={r.cq} cycleCount={cycleCount} color={color} />
              </td>
              <td className="atbl__num">
                <span className="atbl__delta">
                  <span className="atbl__deltanum mono">{formatRfu(r.deltaRfu)}</span>
                  <span className="atbl__deltabar">
                    <span
                      className="atbl__deltafill"
                      style={{
                        width: maxDelta > 0 ? `${(Math.abs(r.deltaRfu) / maxDelta) * 100}%` : 0,
                        background: color,
                      }}
                    />
                  </span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
