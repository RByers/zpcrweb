import { useEffect, useMemo, useRef, useState } from "react";
import { runCompleteness, runProgressFromNames, type FileKind, type Zpcr } from "@zpcrweb/core";
import { OverviewPanel, type InfoRow, type OverviewPanelProps } from "./OverviewPanel";
import { OverviewPlateSection } from "./OverviewPlateSection";
import { AttachPlateMenu } from "../plate/AttachPlateMenu";
import { AttachProtocolMenu } from "../protocol/AttachProtocolMenu";
import { RenameIcon } from "../RenameIcon";
import { usePltdPassword } from "../../state/pltdPassword";
import { runEncryptionStatus } from "../../lib/encryptionStatus";
import { useRunAnalysis } from "../../lib/runAnalysis";
import type { FileSettings, LoadedFile, RunResult } from "../../state/useZpcrStore";
import type { ExperimentIdentity } from "../../lib/experiment";

/**
 * The Overview tab for a run (`.zpcr`/`.pcrd`/Biomeme `.json`).
 *
 * The shared {@link OverviewPanel} plus the things a run adds to it: its editable name as the
 * headline, the "still going" banner, and the run's own facts appended to the info table — then its
 * plate's chips below, tallied against the run's Cq table.
 *
 * **For a pending experiment this tab is also where it gets assembled.** An experiment that hasn't
 * run yet arrives from "New experiment" or "Clone experiment" with a bare-date file name and no
 * name of its own, so this view is what asks for one (required, focused on arrival — see
 * {@link ExperimentHeader}) and what offers the two halves it may still be missing: a protocol and
 * a plate. Those affordances live here, beside the file's own identity, rather than on the Instrument
 * tab where they used to be implied by which chips were selected — an experiment is a file, and
 * what a file is made of is an Overview question.
 */
export function OverviewView({
  zpcr,
  file,
  run,
  settings,
  identity,
  onRename,
  namePersists,
  pending,
  files,
  onAttachPlate,
  onAttachProtocol,
  onCreateProtocol,
  onCloneExperiment,
  autoFocusName,
  onAutoFocusHandled,
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
  /** This experiment hasn't been run yet (`lib/experiment.ts`'s `isPendingExperiment`), so it is
   * still being assembled: the name is required, and the missing halves can be attached. */
  pending: boolean;
  /** Every loaded file, so the attach menus can offer ones already open rather than only a fresh
   * upload — the same list `PlatesView` passes to `AttachPlateMenu`. */
  files: LoadedFile[];
  onAttachPlate: (file: File) => void;
  onAttachProtocol: (file: File) => void;
  /** "new protocol": write the default protocol into this experiment and go edit it. */
  onCreateProtocol: () => void;
  /** Copy this run's protocol and plate into a fresh pending experiment. Replaces the generic
   * file-clone button for a run — see {@link OverviewPanelProps.onClone} for the difference. */
  onCloneExperiment: () => void;
  /** Put the cursor in the experiment-name field as soon as this panel appears — how a
   * just-created or just-cloned experiment arrives, since naming it is the next thing to do. */
  autoFocusName?: boolean;
  /** Called once {@link autoFocusName} has been acted on, so it fires once per new experiment. */
  onAutoFocusHandled?: () => void;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "autoEditName" | "onAutoEditHandled"
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
  /**
   * Whether this run stopped short — over, but with fewer plate reads than its protocol asked
   * for (see core's `runCompleteness`). Read from the file for the same reasons `progress` is,
   * and mutually exclusive with it: a run still going is not incomplete, it is unfinished.
   */
  const completeness = useMemo(() => runCompleteness(zpcr), [zpcr]);

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
    // Everything the *instrument* states about a run it performed. A pending experiment has none of
    // it — no block, no serial, no scan mask, no cycles, no temperature — because nothing has run
    // yet, and a dozen rows of "—" would read as a broken file rather than an empty one. They
    // appear on their own the moment the run does (every snapshot re-parses).
    ...(pending
      ? []
      : [
          { label: "Block", value: m.blockDescription || "—" },
          { label: "Base serial", value: m.baseSerialNumber || "—" },
          { label: "Channels", value: `${m.channelCount} (mask ${m.scanMask})` },
          // `reads.length` for a `.zpcr`/`.pcrd`, but a dye-space source (`Zpcr.dyeSpace`) carries
          // no `PlateRead[]` at all — its curves are already pivoted — so this sums `steps()`
          // instead, which both formats populate. Equivalent for a `.zpcr`/`.pcrd` (`toSteps` is
          // itself a tally of `reads`), and the only number that exists at all for the other kind.
          { label: "Cycles", value: String(steps.reduce((sum, s) => sum + s.readCount, 0)) },
          {
            label: "Plate",
            value: `${m.numberPlateRows}×${m.numberPlateColumns} + ${m.numberReferenceRows} ref`,
          },
        ]),
    { label: "Protocol", value: protocolName || (pending ? "not set yet" : "—") },
    ...(pending ? [] : [{ label: "Last block temp", value: lastTemp != null ? `${lastTemp.toFixed(1)} °C` : "—" }]),
    { label: "Encrypted", value: <EncryptedValue status={encStatus} /> },
    ...(pending ? [] : [{ label: "Identifier", value: m.identifier || "—" }]),
    // Only a `.zpcr` has inner files to count. A `.pcrd` is one XML document and gets
    // `EMPTY_ARCHIVE`, which rendered as a flatly misleading "0 files" — so the row is dropped
    // rather than answered wrongly.
    ...(zpcr.archive.entries.length > 0
      ? [
          {
            label: "Archive entries",
            value: `${zpcr.archive.entries.length} file${zpcr.archive.entries.length === 1 ? "" : "s"}`,
          },
        ]
      : []),
  ];

  return (
    <OverviewPanel
      file={file}
      // The idle "Filename" row shows the resolved display name, not the raw one being edited.
      fileNameDisplay={identity.fileName}
      rows={rows}
      downloadTitle="Download this file (including its zpcrweb.json analysis settings)"
      header={
        <ExperimentHeader
          identity={identity}
          onRename={onRename}
          persists={namePersists}
          // Required only while the experiment can still be started: after that the name has been
          // sent with the run and named its file, and an ordinary run with a derived name is not
          // missing anything.
          required={pending && !identity.named}
          pending={pending}
          autoFocus={autoFocusName}
          onAutoFocusHandled={onAutoFocusHandled}
        />
      }
      banner={
        pending ? (
          <PendingBanner named={identity.named} />
        ) : progress.inProgress ? (
          <RunningBanner plateReads={progress.plateReads} />
        ) : completeness.incomplete ? (
          <IncompleteBanner expected={completeness.expected!} actual={completeness.actual} />
        ) : undefined
      }
      // A run's Clone is "clone the *experiment*", not the file: a byte-for-byte copy of a finished
      // run would be a second copy of results that already exist, which is never the thing wanted.
      // Cloning to run it again is — so that is what the button does here (`App`'s
      // `cloneExperiment`), and the generic file-copy stays on the kinds where it does make sense.
      onClone={onCloneExperiment}
      cloneTitle={
        "Start a new experiment from this one's protocol and plate — a fresh file, with no results, " +
        "ready to be named and run"
      }
      {...tools}
    >
      {/* Attaching either half is a pending-experiment affordance only: for a run that has already
          happened, its protocol and plate are part of the record. (A plate can still be attached to
          a finished run from the Plates tab, which is a different act — labelling results that came
          in without a map, rather than assembling a run.) */}
      {pending && (
        <ExperimentParts
          hasProtocol={!!zpcr.protocolText}
          hasPlate={!!plate}
          files={files}
          onAttachPlate={onAttachPlate}
          onAttachProtocol={onAttachProtocol}
          onCreateProtocol={onCreateProtocol}
        />
      )}
      {/* A missing plate is worth saying whatever state the experiment is in — before the run, it's
          a thing to fix; after it, it's why there are no target or sample names on the curves. */}
      {!pending && !plate && (
        <section className="overview__block">
          <div className="overview__missing mono">
            No plate is attached to this run, so its wells have no target or sample names. One can
            be attached from the Plates tab.
          </div>
        </section>
      )}
      <OverviewPlateSection plate={plate} cqTable={analysis.cqTable} />
    </OverviewPanel>
  );
}

/**
 * The two halves a pending experiment is made of, and the controls to supply whichever is missing.
 *
 * Both are optional, and they are optional in different ways — which is why this says more than
 * "attach a file". A protocol is what the instrument would actually run, so without one there is
 * nothing to start; the Protocol tab is an editor for exactly this reason, and attaching a
 * `.prcl.txt` is the alternative for a protocol meant to be reused across experiments. A plate is
 * only a *map* of what is in the wells, so a run without one still produces every curve — it just
 * can't say which target or sample any of them is.
 */
function ExperimentParts({
  hasProtocol,
  hasPlate,
  files,
  onAttachPlate,
  onAttachProtocol,
  onCreateProtocol,
}: {
  hasProtocol: boolean;
  hasPlate: boolean;
  files: LoadedFile[];
  onAttachPlate: (file: File) => void;
  onAttachProtocol: (file: File) => void;
  onCreateProtocol: () => void;
}) {
  return (
    <section className="overview__block">
      <h2 className="overview__h">Experiment parts</h2>
      <div className="overview__parts">
        <div className="overview__part">
          <div className="overview__partlabel">
            Protocol
            {hasProtocol ? (
              <span className="overview__partok">attached</span>
            ) : (
              <span className="overview__partmissing">required to start</span>
            )}
          </div>
          <p className="decoded__hint">
            {hasProtocol
              ? "Edit it on the Protocol tab, or replace it with another file."
              : "Write a new one, or attach a protocol file you already have."}
          </p>
          <div className="overview__partactions">
            {/* Two peers, not a menu with a hidden option in it: "write one" and "use one I have"
                are the two ways to get a protocol, and they are equally likely. "New protocol" used
                to be a third item inside the attach menu, which buried the more common of the two
                behind the less common one. */}
            {!hasProtocol && (
              <button className="btn btn--sm btn--primary" onClick={onCreateProtocol}>
                new protocol
              </button>
            )}
            <AttachProtocolMenu
              files={files}
              compactLabel={hasProtocol ? "replace protocol" : "attach protocol"}
              confirmReplace={hasProtocol}
              onSelect={(f) => onAttachProtocol(new File([f.bytes.slice()], f.name))}
              onUpload={onAttachProtocol}
            />
          </div>
        </div>
        <div className="overview__part">
          <div className="overview__partlabel">
            Plate
            {hasPlate ? (
              <span className="overview__partok">attached</span>
            ) : (
              <span className="overview__partmissing">optional</span>
            )}
          </div>
          <p className="decoded__hint">
            {hasPlate
              ? "The map of what's in each well. Replace it to re-label the same protocol's wells."
              : "Without a plate this experiment can still run — its curves just won't carry target " +
                "or sample names."}
          </p>
          <AttachPlateMenu
            files={files}
            compactLabel={hasPlate ? "replace plate" : "attach plate"}
            confirmReplace={hasPlate}
            onSelect={(f) => onAttachPlate(new File([f.bytes.slice()], f.name))}
            onUpload={onAttachPlate}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * A pending experiment's banner: what this file is, and what it still needs.
 *
 * Worth a banner rather than a badge because "pending" is the one file state that is *about to
 * change through the user's own next action* — every other banner reports something that already
 * happened to the run. It replaces the very transitory seed file the old flow produced at the click
 * on Start: that file existed for minutes and nobody ever chose to make one, whereas this is a
 * thing you deliberately create and then fill in.
 */
function PendingBanner({ named }: { named: boolean }) {
  return (
    <div className="overview__pending">
      <span className="overview__pendingmark" aria-hidden="true" />
      <span>
        <strong>This experiment hasn't been run yet.</strong>{" "}
        {named
          ? "Give it a protocol and (optionally) a plate below, then start it from the Instrument tab."
          : "Name it above — that name identifies the run and its file — then give it a protocol below."}
      </span>
    </div>
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
 * A run that ended without finishing its protocol — see {@link OverviewView}'s `completeness`.
 *
 * Worth saying at this length rather than as a word, because the file itself looks normal: an
 * aborted run writes the same `ended` marker as a completed one and its `.alf` report still says
 * `Protocol completed.` with the user-aborted flag clear (`usb.md` §7.8, `alf.md` §6). The read
 * count is the only thing that gives it away, so the banner shows the arithmetic it is accusing
 * on — and names the one innocent explanation, since the app cannot tell the two apart.
 */
function IncompleteBanner({ expected, actual }: { expected: number; actual: number }) {
  return (
    <div className="overview__incomplete">
      <span className="overview__incompletemark" aria-hidden="true" />
      <span>
        <strong>This run is incomplete.</strong> Its protocol calls for {expected} plate read
        {expected === 1 ? "" : "s"} and the archive holds {actual} — so the run ended{" "}
        {expected - actual === 1 ? "one cycle" : `${expected - actual} cycles`} early. Nothing in
        a run's files records an abort, so this is inferred from the count: usually it means the
        run was cancelled, and it can also mean the instrument stopped on its own. Whatever cycles
        are here are ordinary, complete reads.
      </span>
    </div>
  );
}

/**
 * The panel's headline: what the run is called. When it ran and which file it came out of are
 * rows of the info table below instead of a subheading here — see `rows`.
 *
 * No Bio-Rad format has a field for a run's name, so a run is named either by its filename or by
 * whatever gets typed here, which is then stored in the archive's own `zpcrweb.json` and travels
 * with the file (see `state/analysisSettings.ts`). Clearing it is meaningful — it removes the stored
 * name, and the run reverts to the one derived from its filename.
 *
 * **How editable it is depends on whether the experiment has run**, which is the app's rule for
 * every mutation and not just this field (see `apps/web/ARCHITECTURE.md`, "Editing what has already
 * happened"). Three states:
 *
 * | State | The field |
 * | ----- | --------- |
 * | pending, unnamed | a live input, marked **required** — the experiment can't start without one |
 * | pending, named | a live input; the experiment is still being assembled, so typing is the point |
 * | run (in progress, or over) | a heading, with an edit button that turns it into an input |
 *
 * That last state is the one worth explaining. The name of a run that happened is part of its
 * record: it went out as `RemoteRun`'s operand, was deposited into the run folder, and named the
 * file. Editing it is *allowed* — it is the app's own field, and correcting a typo afterwards is
 * legitimate — but it should take saying so, because a text cursor sitting in a record invites an
 * accidental keystroke that rewrites the archive. So the edit is one click away rather than zero,
 * the same shape the "Filename" row already uses ({@link OverviewPanel}'s `useFilenameEditor`).
 *
 * Edits commit on blur or Enter rather than on every keystroke: each commit eventually rewrites
 * the archive, and Escape has to be able to abandon a half-typed name.
 */
function ExperimentHeader({
  identity,
  onRename,
  persists,
  required,
  pending,
  autoFocus,
  onAutoFocusHandled,
}: {
  identity: ExperimentIdentity;
  onRename: (name: string) => void;
  persists: boolean;
  /** This experiment has no name of its own yet and can't be started until it does — see
   * {@link OverviewView}'s `pending`. Shown as a required field rather than merely empty. */
  required: boolean;
  /** The experiment hasn't run, so it is still being assembled and the field is live. */
  pending: boolean;
  autoFocus?: boolean;
  onAutoFocusHandled?: () => void;
}) {
  // A field showing the bare-date placeholder derived from the file name would look already
  // answered, and the first keystroke would append to it. An unnamed experiment therefore starts
  // empty, with the placeholder text carrying the example instead.
  const [draft, setDraft] = useState(required ? "" : identity.name);
  // Re-seed when the resolved name changes underneath — a different file, or a rename arriving
  // from elsewhere. Keyed on the value, so typing is never interrupted by an unrelated render.
  useEffect(() => setDraft(required ? "" : identity.name), [identity.name, required]);

  /** Whether the input is showing at all. Always, while pending; only once asked for, after that. */
  const [editing, setEditing] = useState(false);
  const live = pending || editing;
  // A run that finishes while its name is open for editing closes it: by then the name is part of a
  // record, which is exactly the state the edit gate exists for.
  useEffect(() => {
    if (pending) return;
    setEditing(false);
  }, [pending]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    onAutoFocusHandled?.();
  }, [autoFocus, onAutoFocusHandled]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    // Covers "cleared, and the derived name is what was showing anyway": nothing to store.
    if (next === identity.name) return;
    onRename(next);
    if (!next && !required) setDraft(identity.name);
  };

  const title = required
    ? "What to call this experiment — required, and never guessed. It identifies the run, " +
      "names its file, and is sent to the instrument with it."
    : persists
      ? "The run's name — stored in the file's own zpcrweb.json, so it travels with the " +
        "file. Clear it to go back to the name derived from the file name."
      : "The run's name. This format has no archive to store it in, so the name lasts for " +
        "this session only.";

  if (!live) {
    return (
      <header className="overview__title">
        <h1 className="overview__nametext" title={title}>
          {identity.name}
        </h1>
        <button
          className="raw__download overview__nameeditbtn"
          onClick={() => setEditing(true)}
          aria-label="Rename this experiment"
          title={
            "Rename this experiment. Its name is part of the record of a run that happened, so " +
            "editing it takes a click rather than being one stray keystroke away."
          }
        >
          <RenameIcon />
        </button>
      </header>
    );
  }

  return (
    <header className="overview__title">
      <input
        ref={inputRef}
        className={"overview__name" + (required ? " is-missing" : "")}
        value={draft}
        // Only when the click on the edit button is what opened it: a pending experiment's field is
        // live from the start, where stealing focus would fight both `autoFocus` above and a reader
        // who came to look rather than to type.
        autoFocus={editing}
        onFocus={(e) => editing && e.currentTarget.select()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(required ? "" : identity.name);
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        aria-label="Experiment name"
        aria-required={required || undefined}
        required={required || undefined}
        placeholder={required ? "Name this experiment — e.g. S183-S185 RVP" : undefined}
        spellCheck={false}
        title={title}
      />
      {required && (
        <span
          className="overview__namerequired"
          title="Required — an experiment is not started without one"
        >
          required
        </span>
      )}
    </header>
  );
}
