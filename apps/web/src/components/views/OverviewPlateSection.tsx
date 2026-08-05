import { plateTargets, type CqTableEntry, type PlateDefinition } from "@zpcrweb/core";
import { fluorColor } from "../../lib/fluorColors";
import { curveKey } from "../../lib/runAnalysis";

/**
 * An Overview's "Plate" section: the plate's targets and samples as chips, each carrying its
 * positive/negative curve tally when there is a run to tally.
 *
 * One component for both callers. A standalone plate has no analysis behind it, so its chips are
 * bare — but that is the *same* section with no `cqTable` passed, not a second implementation:
 * {@link CountChip} already falls back to a plain name chip, and {@link byCountsDesc} is a stable
 * no-op when every item counts 0/0, leaving the plate's own order. Keeping the two apart is what
 * let the run's chips gain colours and tallies the plate's never got.
 */
export function OverviewPlateSection({
  plate,
  cqTable,
}: {
  plate: PlateDefinition | null;
  /** The run's Cq table, when this plate sits inside a run — the same `useRunAnalysis` result the
   * Curves view reads, so the tallies can't drift from the Cq values that view shows. Absent for
   * a standalone plate, which has nothing to tally. */
  cqTable?: Map<string, CqTableEntry>;
}) {
  if (!plate) return null;
  const { byTarget, bySample } = chipCounts(plate, cqTable);
  // Most-amplified first, so the chips that carry the run's signal lead each list.
  const targets = byCountsDesc(plateTargets(plate), (t) => byTarget.get(t.name));
  const samples = byCountsDesc(plate.samples ?? [], (s) => bySample.get(s));
  if (targets.length === 0 && samples.length === 0) return null;

  return (
    <section className="overview__block">
      <h2 className="overview__h">Plate{plate.identityKey ? `: ${plate.identityKey}` : ""}</h2>
      <div className="overview__platelists">
        {targets.length > 0 && (
          <div className="overview__platelist">
            <div className="overview__platelist-h">Targets</div>
            <div className="filecard__chips">
              {targets.map((t) => (
                <CountChip
                  key={t.name}
                  name={t.name}
                  counts={byTarget.get(t.name)}
                  color={t.fluor != null ? fluorColor(t.fluor) : undefined}
                />
              ))}
            </div>
          </div>
        )}
        {samples.length > 0 && (
          <div className="overview__platelist">
            <div className="overview__platelist-h">Samples</div>
            <div className="filecard__chips">
              {samples.map((s) => (
                <CountChip key={s} name={s} counts={bySample.get(s)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Positive/negative curve tally behind one plate chip — see {@link chipCounts}. */
interface Counts {
  pos: number;
  neg: number;
}

/**
 * Positive (Cq found) and negative (no Cq) curve counts per target and per sample, over the
 * loaded well/fluor pairs — the same population the Curves view's table lists.
 *
 * Counted per *curve*, not per well: a duplexed well contributes one curve to each of its dyes,
 * so a sample's positives and negatives can exceed its well count. Wells the plate never loaded
 * are skipped — they have no measurement to call either way.
 *
 * The tallies come out empty when there is no Cq table at all (a standalone plate) or when it is
 * empty (an uncalibrated run, or a plate still behind the password prompt), which shows the chips
 * bare.
 */
function chipCounts(
  plate: PlateDefinition,
  cqTable: Map<string, CqTableEntry> | undefined,
): { byTarget: Map<string, Counts>; bySample: Map<string, Counts> } {
  const byTarget = new Map<string, Counts>();
  const bySample = new Map<string, Counts>();
  if (!cqTable || cqTable.size === 0) return { byTarget, bySample };
  const bump = (m: Map<string, Counts>, key: string, positive: boolean) => {
    const c = m.get(key) ?? { pos: 0, neg: 0 };
    if (positive) c.pos++;
    else c.neg++;
    m.set(key, c);
  };
  for (const w of plate.wells) {
    if (!w.loaded) continue;
    for (const wf of w.fluors) {
      const entry = cqTable.get(curveKey(w.row, w.col, wf.fluor));
      if (!entry) continue;
      const positive = entry.cq != null;
      if (wf.target) bump(byTarget, wf.target, positive);
      if (w.sample) bump(bySample, w.sample, positive);
    }
  }
  return { byTarget, bySample };
}

/**
 * Orders chips by positive curves descending, then by total curves descending — the tally
 * {@link CountChip} already shows, so the list reads top-to-bottom in the same order as the
 * numbers on the chips. Items with no counts at all (a standalone plate, an uncalibrated run, or
 * a name whose wells were never loaded) sort to the end at 0/0, and ties keep the plate's own
 * order, since `sort` is stable — which is what makes an untallied plate come out in plate order.
 */
function byCountsDesc<T>(items: readonly T[], counts: (item: T) => Counts | undefined): T[] {
  const pos = (item: T) => counts(item)?.pos ?? 0;
  const total = (item: T) => {
    const c = counts(item);
    return c ? c.pos + c.neg : 0;
  };
  return [...items].sort((a, b) => pos(b) - pos(a) || total(b) - total(a));
}

/**
 * A plate chip carrying its positive/negative tally: the two counts either side of a small track
 * whose filled portion is the positive fraction, so a column of chips can be scanned for "mostly
 * amplified" vs "mostly flat" without reading the digits. Falls back to a plain name chip when
 * there's nothing to count.
 */
function CountChip({ name, counts, color }: { name: string; counts?: Counts; color?: string }) {
  const style = color ? { color } : undefined;
  if (!counts || counts.pos + counts.neg === 0) {
    return (
      <span className="filecard__chip" style={style}>
        {name}
      </span>
    );
  }
  const total = counts.pos + counts.neg;
  const pct = (counts.pos / total) * 100;
  return (
    <span
      className="filecard__chip chipcount"
      style={style}
      title={`${counts.pos} positive (Cq), ${counts.neg} negative (no Cq) of ${total} curves`}
    >
      <span className="chipcount__name">{name}</span>
      <span className="chipcount__pos mono">{counts.pos}</span>
      <span className="chipcount__bar" aria-hidden="true">
        <span className="chipcount__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="chipcount__neg mono">{counts.neg}</span>
    </span>
  );
}
