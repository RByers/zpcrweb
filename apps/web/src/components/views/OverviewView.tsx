import { useMemo } from "react";
import type { CqTableEntry, PlateDefinition, Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { DownloadIcon } from "../DownloadIcon";
import { downloadBytes } from "../../lib/download";
import { usePltdPassword } from "../../state/pltdPassword";
import { plateTargets } from "../../lib/plateTargets";
import { channelColor } from "../../lib/channelColors";
import { runEncryptionStatus } from "../../lib/encryptionStatus";
import { curveKey, useRunAnalysis } from "../../lib/runAnalysis";
import type { FileSettings, RunResult } from "../../state/useZpcrStore";

interface Tile {
  label: string;
  value: string;
}

/** Positive/negative curve tally behind one plate chip — see {@link chipCounts}. */
interface Counts {
  pos: number;
  neg: number;
}

export function OverviewView({
  zpcr,
  file,
  run,
  settings,
  onDownload,
}: {
  zpcr: Zpcr;
  /** The active run's own name/bytes — downloaded verbatim, so this is also how a `.zpcr`
   * attached via the Plates view's upload control gets back onto disk (see `PlatesView`). */
  file: { name: string; bytes: Uint8Array };
  /** Bytes for the download button: the loaded archive plus the run's current analysis settings
   * as its `zpcrweb.json` entry (`ZpcrStore.exportBytes`), so the copy that leaves the browser
   * carries the thresholds it was read with. Falls back to `file.bytes` when absent. */
  onDownload?: () => Uint8Array | null;
  /** The same run result the app resolved `zpcr` from — carries the `selfEncrypted` flag that
   * `zpcr` alone doesn't expose. Format-neutral: see {@link runEncryptionStatus}. */
  run: RunResult;
  /** Only used to feed {@link useRunAnalysis} — the plate chips' Cq tallies must be the same
   * numbers the Curves view shows, which means the same thresholds and calibration settings. */
  settings: FileSettings;
}) {
  const m = zpcr.metadata;
  const reads = zpcr.reads;
  const protocolText = zpcr.protocolText || null;
  const protocol = zpcr.protocol();
  const protocolName = protocol?.name || null;
  const lastTemp = reads.at(-1)?.blockTempC;

  const [password] = usePltdPassword();
  const plate = useMemo(() => zpcr.plates(password || undefined)[0]?.pltd.plate ?? null, [zpcr, password]);
  const encStatus = useMemo(() => runEncryptionStatus(run, password), [run, password]);
  const plateTargetList = useMemo(() => (plate ? plateTargets(plate) : []), [plate]);
  const plateSamples = plate?.samples ?? [];

  // The run's Cq table, so each chip can say how many of its curves amplified. Read from the same
  // `useRunAnalysis` the Curves view uses (over the same first step) rather than tallied here, so
  // the counts can't drift from the Cq values that view shows — see `runAnalysis.ts`.
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);
  const analysis = useRunAnalysis(zpcr, settings, password, activeStep);
  const { byTarget, bySample } = useMemo(
    () => chipCounts(plate, analysis.cqTable),
    [plate, analysis.cqTable],
  );

  // Most-amplified first, so the chips that carry the run's signal lead each list.
  const targets = useMemo(
    () => byCountsDesc(plateTargetList, (t) => byTarget.get(t.name)),
    [plateTargetList, byTarget],
  );
  const samples = useMemo(
    () => byCountsDesc(plateSamples, (s) => bySample.get(s)),
    [plateSamples, bySample],
  );

  const tiles: Tile[] = [
    { label: "Block", value: m.blockDescription || "—" },
    { label: "Base serial", value: m.baseSerialNumber || "—" },
    { label: "Channels", value: `${m.channelCount} (mask ${m.scanMask})` },
    { label: "Cycles", value: String(reads.length) },
    { label: "Plate", value: `${m.numberPlateRows}×${m.numberPlateColumns} + ${m.numberReferenceRows} ref` },
    { label: "Protocol", value: protocolName || "—" },
    { label: "Run start", value: m.runStartDate ? m.runStartDate.toUTCString() : m.runStartTime || "—" },
    { label: "Last block temp", value: lastTemp != null ? `${lastTemp.toFixed(1)} °C` : "—" },
  ];

  return (
    <div className="overview">
      <div className="overview__head">
        <section className="overview__tiles">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile__label">{t.label}</div>
              <div className="tile__value mono">{t.value}</div>
            </div>
          ))}
        </section>

        <div className="overview__toolbar">
          <button
            className="raw__download"
            onClick={() => downloadBytes(file.name, onDownload?.() ?? file.bytes)}
            aria-label={`Download ${file.name}`}
            title="Download this file (including its zpcrweb.json analysis settings)"
          >
            <DownloadIcon />
          </button>
        </div>
      </div>

      {protocol?.steps ? (
        <section className="overview__block">
          <h2 className="overview__h">Thermal protocol</h2>
          <ProtocolStepsTable steps={protocol.steps} />
        </section>
      ) : (
        protocolText && (
          <section className="overview__block">
            <h2 className="overview__h">Thermal protocol</h2>
            <ProtocolDecoded text={protocolText} />
          </section>
        )
      )}

      {plate && (targets.length > 0 || samples.length > 0) && (
        <section className="overview__block">
          <h2 className="overview__h">Plate</h2>
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
                      color={t.channel != null ? channelColor(t.channel) : undefined}
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
      )}

      <section className="overview__block">
        <h2 className="overview__h">Encrypted</h2>
        {encStatus.kind === "none" && <div className="overview__enc overview__enc--none">No</div>}
        {encStatus.kind === "decrypted" && (
          <div className="overview__enc overview__enc--decrypted">
            Yes
            <div className="overview__enc-password mono">password: {encStatus.password}</div>
          </div>
        )}
        {encStatus.kind === "locked" && <div className="overview__enc overview__enc--locked">Yes</div>}
      </section>

      <section className="overview__block">
        <h2 className="overview__h">Run identity</h2>
        <dl className="overview__dl mono">
          <dt>Identifier</dt>
          <dd>{m.identifier || "—"}</dd>
          <dt>Data file</dt>
          <dd>{m.dataFile || "—"}</dd>
          {/* Only a `.zpcr` has inner files to count. A `.pcrd` is one XML document and gets
              `EMPTY_ARCHIVE`, which rendered as a flatly misleading "0 files" — so the row is
              dropped rather than answered wrongly. This is the one place Overview notices the
              archive at all; everything else it shows is decoded run data. */}
          {zpcr.archive.entries.length > 0 && (
            <>
              <dt>Archive entries</dt>
              <dd>{zpcr.archive.entries.length} files</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  );
}

/**
 * Positive (Cq found) and negative (no Cq) curve counts per target and per sample, over the
 * loaded well/fluor pairs — the same population the Curves view's table lists.
 *
 * Counted per *curve*, not per well: a duplexed well contributes one curve to each of its dyes,
 * so a sample's positives and negatives can exceed its well count. Wells the plate never loaded
 * are skipped — they have no measurement to call either way.
 *
 * The tallies come out empty when the Cq table is (an uncalibrated run, or a plate still behind
 * the password prompt), which shows the chips bare, exactly as before.
 */
function chipCounts(
  plate: PlateDefinition | null,
  cqTable: Map<string, CqTableEntry>,
): { byTarget: Map<string, Counts>; bySample: Map<string, Counts> } {
  const byTarget = new Map<string, Counts>();
  const bySample = new Map<string, Counts>();
  if (!plate || cqTable.size === 0) return { byTarget, bySample };
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
 * numbers on the chips. Items with no counts at all (an uncalibrated run, or a name whose wells
 * were never loaded) sort to the end at 0/0, and ties keep the plate's own order, since `sort`
 * is stable.
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
