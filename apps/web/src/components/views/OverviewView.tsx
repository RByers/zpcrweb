import { useEffect, useMemo, useState } from "react";
import { runProgressFromNames, type FileKind, type Zpcr } from "@zpcrweb/core";
import { OverviewPanel, type InfoRow, type OverviewPanelProps } from "./OverviewPanel";
import { OverviewPlateSection } from "./OverviewPlateSection";
import { usePltdPassword } from "../../state/pltdPassword";
import { runEncryptionStatus } from "../../lib/encryptionStatus";
import { useRunAnalysis } from "../../lib/runAnalysis";
import type { FileSettings, RunResult } from "../../state/useZpcrStore";
import type { ExperimentIdentity } from "../../lib/experiment";

/**
 * The Overview tab for a run (`.zpcr`/`.pcrd`/Biomeme `.json`).
 *
 * The shared {@link OverviewPanel} plus the three things a run adds to it: its editable name as
 * the headline, the "still going" banner, and the run's own facts appended to the info table —
 * then its plate's chips below, tallied against the run's Cq table.
 */
export function OverviewView({
  zpcr,
  file,
  run,
  settings,
  identity,
  onRename,
  namePersists,
  ...tools
}: {
  zpcr: Zpcr;
  /** The active run's own name/kind/mtime. The bytes aren't needed here — saving the file is
   * `App.tsx`'s `downloadActiveFile`, the same one every other kind's Overview uses. */
  file: { name: string; kind: FileKind; lastModified: number };
  /** The same run result the app resolved `zpcr` from — carries the `selfEncrypted` flag that
   * `zpcr` alone doesn't expose. Format-neutral: see {@link runEncryptionStatus}. */
  run: RunResult;
  /** Only used to feed {@link useRunAnalysis} — the plate chips' Cq tallies must be the same
   * numbers the Curves view shows, which means the same thresholds and calibration settings. */
  settings: FileSettings;
  /** What this run is called and when it ran — the panel's headline; see `lib/experiment.ts`. */
  identity: ExperimentIdentity;
  /** Store a new name (`zpcrweb.json`'s `experimentName`). `""` clears it, which puts the run
   * back on its derived name. Distinct from {@link OverviewPanelProps.onRenameFile}, which
   * renames the file itself. */
  onRename: (name: string) => void;
  /** False when the format can't carry the name to disk (`.pcrd`, Biomeme — neither has an
   * archive to hold a `zpcrweb.json`), which the field then says out loud rather than silently
   * losing the edit on reload. */
  namePersists: boolean;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "onClone" | "autoEditName" | "onAutoEditHandled"
>) {
  const m = zpcr.metadata;
  const protocolName = zpcr.protocol()?.name || null;
  const lastTemp = zpcr.reads.at(-1)?.blockTempC;

  /**
   * Whether this run is still running, read from the archive's own marker files: `begun` present,
   * `ended` absent (see core's `runProgressFromNames`).
   *
   * Nothing about the instrument connection is consulted, and nothing is stored. A run pulled
   * mid-cycle carries the evidence inside it, so the banner is right after a reload, right on a
   * copy opened on another machine, and gone the moment a later snapshot arrives with `ended`.
   */
  const progress = useMemo(() => runProgressFromNames(zpcr.archive.entries), [zpcr]);

  const [password] = usePltdPassword();
  const plate = useMemo(() => zpcr.plates(password || undefined)[0]?.pltd.plate ?? null, [zpcr, password]);
  const encStatus = useMemo(() => runEncryptionStatus(run, password), [run, password]);

  // The run's Cq table, so each chip can say how many of its curves amplified. Read from the same
  // `useRunAnalysis` the Curves view uses (over the same first step) rather than tallied here, so
  // the counts can't drift from the Cq values that view shows — see `runAnalysis.ts`.
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);
  const analysis = useRunAnalysis(zpcr, settings, password, activeStep);

  // Appended to the panel's own file-identity rows: the run's facts (block/serial/channels/…)
  // and, at the end, the encryption status and archive identity.
  const rows: InfoRow[] = [
    // Omitted rather than shown as "—": a standalone plate/protocol file has no run date at all,
    // and a blank row would read as a missing value rather than a nonsensical question.
    ...(identity.dateText ? [{ label: "Run date", value: identity.dateText }] : []),
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
    { label: "Last block temp", value: lastTemp != null ? `${lastTemp.toFixed(1)} °C` : "—" },
    { label: "Encrypted", value: <EncryptedValue status={encStatus} /> },
    { label: "Identifier", value: m.identifier || "—" },
    // Only a `.zpcr` has inner files to count. A `.pcrd` is one XML document and gets
    // `EMPTY_ARCHIVE`, which rendered as a flatly misleading "0 files" — so the row is dropped
    // rather than answered wrongly.
    ...(zpcr.archive.entries.length > 0
      ? [{ label: "Archive entries", value: `${zpcr.archive.entries.length} files` }]
      : []),
  ];

  return (
    <OverviewPanel
      file={file}
      // The idle "Filename" row shows the resolved display name, not the raw one being edited.
      fileNameDisplay={identity.fileName}
      rows={rows}
      downloadTitle="Download this file (including its zpcrweb.json analysis settings)"
      header={<ExperimentHeader identity={identity} onRename={onRename} persists={namePersists} />}
      banner={progress.inProgress ? <RunningBanner plateReads={progress.plateReads} /> : undefined}
      {...tools}
    >
      <OverviewPlateSection plate={plate} cqTable={analysis.cqTable} />
    </OverviewPanel>
  );
}

/** The "Encrypted" row's value, in the same wording/colors the section used to render on its
 * own — just now one row of the info table instead of a whole section. */
function EncryptedValue({ status }: { status: ReturnType<typeof runEncryptionStatus> }) {
  if (status.kind === "none") return <span className="overview__enc overview__enc--none">No</span>;
  if (status.kind === "decrypted")
    return (
      <span className="overview__enc overview__enc--decrypted">
        Yes
        <span className="overview__enc-password mono"> (password: {status.password})</span>
      </span>
    );
  return <span className="overview__enc overview__enc--locked">Yes</span>;
}

/** A run whose archive says it hasn't finished — see {@link OverviewView}'s `progress`. */
function RunningBanner({ plateReads }: { plateReads: number }) {
  return (
    <div className="overview__running">
      <span className="overview__runningdot" aria-hidden="true" />
      <span>
        <strong>This run is still going.</strong> It has {plateReads} plate read
        {plateReads === 1 ? "" : "s"} so far — the instrument has written its <code>begun</code>{" "}
        marker but not <code>ended</code>. With the instrument connected and following switched on,
        this file is replaced with a fuller one after every cycle.
      </span>
    </div>
  );
}

/**
 * The panel's headline: what the run is called. When it ran and which file it came out of are
 * rows of the info table below instead of a subheading here — see `rows`.
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
}: {
  identity: ExperimentIdentity;
  onRename: (name: string) => void;
  persists: boolean;
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
    </header>
  );
}
