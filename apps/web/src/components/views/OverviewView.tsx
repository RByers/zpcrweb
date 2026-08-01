import { useEffect, useMemo, useState } from "react";
import { formatRunDefinitionText, type CqTableEntry, type PlateDefinition, type Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { DownloadIcon } from "../DownloadIcon";
import { downloadBytes, downloadText } from "../../lib/download";
import { protocolFileBase } from "../../lib/protocolSource";
import { usePltdPassword } from "../../state/pltdPassword";
import { plateTargets } from "../../lib/plateTargets";
import { channelColor } from "../../lib/channelColors";
import { runEncryptionStatus } from "../../lib/encryptionStatus";
import { curveKey, useRunAnalysis } from "../../lib/runAnalysis";
import type { FileSettings, RunResult } from "../../state/useZpcrStore";
import type { ExperimentIdentity } from "../../lib/experiment";

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
  identity,
  onRename,
  namePersists,
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
  /** What this run is called and when it ran — the view's headline; see `lib/experiment.ts`. */
  identity: ExperimentIdentity;
  /** Store a new name (`zpcrweb.json`'s `experimentName`). `""` clears it, which puts the run
   * back on its derived name. */
  onRename: (name: string) => void;
  /** False when the format can't carry the name to disk (`.pcrd`, Biomeme — neither has an
   * archive to hold a `zpcrweb.json`), which the field then says out loud rather than silently
   * losing the edit on reload. */
  namePersists: boolean;
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
    // `reads.length` for a `.zpcr`/`.pcrd`, but a dye-space source (`Zpcr.dyeSpace`) carries no
    // `PlateRead[]` at all — its curves are already pivoted — so this sums `steps()` instead,
    // which both formats populate. Equivalent for a `.zpcr`/`.pcrd` (`toSteps` is itself a tally
    // of `reads`), and the only number that exists at all for the other kind.
    { label: "Cycles", value: String(steps.reduce((sum, s) => sum + s.readCount, 0)) },
    { label: "Plate", value: `${m.numberPlateRows}×${m.numberPlateColumns} + ${m.numberReferenceRows} ref` },
    { label: "Protocol", value: protocolName || "—" },
    // No "Run start" tile: the headline above already carries it, in local time.
    { label: "Last block temp", value: lastTemp != null ? `${lastTemp.toFixed(1)} °C` : "—" },
  ];

  return (
    <div className="overview">
      <ExperimentHeader
        identity={identity}
        onRename={onRename}
        persists={namePersists}
        runStartTime={m.runStartTime}
      />
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

      {(protocol?.steps || protocolText) && (
        <section className="overview__block">
          <div className="overview__blockhead">
            <h2 className="overview__h">Thermal protocol</h2>
            {/* The ASCII run definition, not the `.prcl` — see the button's own title. Offered
                only when the run carries that text form at all; a run whose protocol is
                structured-only would have nothing to write. */}
            {protocolText && (
              <button
                className="raw__download"
                onClick={() =>
                  downloadText(
                    `${protocolFileBase(protocolName, file.name)}.prcl.txt`,
                    formatRunDefinitionText(protocolText),
                  )
                }
                aria-label="Download the thermal protocol as .prcl.txt"
                title={
                  "Download the ASCII run definition as .prcl.txt — one directive per line. " +
                  "This is the form the instrument itself records, and what the Device view " +
                  "loads to stage a protocol for a new run."
                }
              >
                <DownloadIcon />
              </button>
            )}
          </div>
          {protocol?.steps ? (
            <ProtocolStepsTable steps={protocol.steps} />
          ) : (
            <ProtocolDecoded text={protocolText!} />
          )}
        </section>
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
 * The view's headline: what the run is called, and — smaller and dimmer, one line below — when
 * it ran and which file it came out of.
 *
 * The name is an input rather than a label because for a `.zpcr` it is genuinely editable: no
 * Bio-Rad format has a field for it, so a run is named either by its filename or by whatever
 * gets typed here, which is then stored in the archive's own `zpcrweb.json` and travels with the
 * file (see `state/analysisSettings.ts`). Clearing the field is meaningful — it removes the
 * stored name, and the run reverts to the one derived from its filename.
 *
 * Edits commit on blur or Enter rather than on every keystroke: each commit eventually rewrites
 * the archive, and Escape has to be able to abandon a half-typed name.
 */
function ExperimentHeader({
  identity,
  onRename,
  persists,
  runStartTime,
}: {
  identity: ExperimentIdentity;
  onRename: (name: string) => void;
  persists: boolean;
  /** The raw `RunStartTime` string, as the timestamp's tooltip — the headline renders a compact
   * *local* time, and this is the instrument's own (GMT) wording behind it. */
  runStartTime: string;
}) {
  const [draft, setDraft] = useState(identity.name);
  // Re-seed when the resolved name changes underneath — a different file, or a rename arriving
  // from elsewhere. Keyed on the value, so typing is never interrupted by an unrelated render.
  useEffect(() => setDraft(identity.name), [identity.name]);

  const commit = () => {
    const next = draft.trim();
    // Covers "cleared, and the derived name is what was showing anyway": nothing to store.
    if (next === identity.name) return;
    onRename(next);
    if (!next) setDraft(identity.name);
  };

  return (
    <header className="overview__title">
      <input
        className="overview__name"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(identity.name);
            e.currentTarget.blur();
          }
        }}
        aria-label="Experiment name"
        spellCheck={false}
        title={
          persists
            ? "The run's name — stored in the file's own zpcrweb.json, so it travels with the " +
              "file. Clear it to go back to the name derived from the file name."
            : "The run's name. This format has no archive to store it in, so the name lasts for " +
              "this session only."
        }
      />
      <div className="overview__subtitle mono">
        {identity.dateText && (
          <span className="overview__when" title={runStartTime || undefined}>
            {identity.dateText}
          </span>
        )}
        <span className="overview__filename">{identity.fileName}</span>
      </div>
    </header>
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
