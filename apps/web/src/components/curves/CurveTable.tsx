import type { AnalysisRow } from "../../lib/analysisRows";

interface Props {
  rows: AnalysisRow[];
  /** Whether the plate assigns targets at all — when it doesn't, the group *is* the fluorophore
   * and the Target column would just repeat the Fluor one. */
  usingTargets: boolean;
}

/**
 * The Curves view's table mode: the run's Cq/ΔRFU table, in place of the chart. Pure
 * presentation — every value is looked up in the run's one Cq table upstream (see
 * `lib/analysisRows.ts`).
 *
 * A row with no Cq renders greyed out (`.is-unamplified`) rather than being hidden, so a well
 * disqualified by the §7 baseline gate or the amplification squelch stays visible instead of
 * silently vanishing from the table.
 */
export function CurveTable({ rows, usingTargets }: Props) {
  if (rows.length === 0) {
    return (
      <div className="chart__empty mono">
        No target/well combinations selected — enable targets and wells to populate the table.
      </div>
    );
  }
  return (
    <table className="analysis__tbl runlog__tbl">
      <thead>
        <tr>
          <th>Well</th>
          <th>Sample</th>
          <th>Fluor</th>
          {usingTargets && <th>Target</th>}
          <th>Baseline</th>
          <th>Threshold</th>
          <th>Cq</th>
          <th>ΔRFU</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`${r.target}-${r.wellLabel}-${r.fluor}`}
            className={"analysis__row" + (r.cq == null ? " is-unamplified" : "")}
          >
            <td>{r.wellLabel}</td>
            <td>{r.sample || "—"}</td>
            <td>{r.fluor}</td>
            {usingTargets && <td>{r.target}</td>}
            <td className="mono">{r.baselineFormula}</td>
            <td>{r.threshold.toFixed(1)}</td>
            <td>{r.cq != null ? r.cq.toFixed(2) : "—"}</td>
            <td>{r.deltaRfu.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
