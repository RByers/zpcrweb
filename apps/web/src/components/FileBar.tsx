import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import { usePltdPassword } from "../state/pltdPassword";
import { channelColor } from "../lib/channelColors";
import {
  plateFileEncryptionStatus,
  runEncryptionStatus,
  type EncryptionStatus,
} from "../lib/encryptionStatus";
import type { ExperimentIdentity } from "../lib/experiment";
import { fileCategory, plateTargets, type FileCategory } from "@zpcrweb/core";
import { FileKindIcon } from "./FileIcons";
import { TrashIcon } from "./TrashIcon";

/** Tooltip wording for the chip icon — its shape, then its colour. */
const CATEGORY_TEXT: Record<FileCategory, string> = {
  run: "Run",
  plate: "Plate map",
  protocol: "Thermal protocol",
};
const ENCRYPTION_TEXT: Record<EncryptionStatus["kind"], string> = {
  none: "not encrypted",
  decrypted: "encrypted, decrypted",
  locked: "encrypted, locked",
};

interface Props {
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  /** The **primary selection** — one chip, in cyan, that a click switches and can never clear.
   * Usually `ZpcrStore.activeId`, the file every view is pointed at; in the Instrument view,
   * which shows no file, it is the run being staged (`App.tsx`). */
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
  /**
   * The *auxiliary* files staged alongside the primary one, for the Instrument view: a plate or
   * protocol file overriding half of the run being assembled (see `useRunStaging.ts`). They are
   * highlighted magenta, and toggle on and off, where {@link Props.activeId} stays what it always
   * is — the one primarily selected file, in the app's usual cyan. Passing this puts the bar in
   * multi-select mode; the run is never in here, since it *is* the primary selection there.
   */
  stagedIds?: Set<string>;
  /** Files whose content has been edited since it was loaded and not since downloaded
   * (`ZpcrStore.modifiedIds`). Deleting one of those throws work away that exists nowhere else,
   * so its chip asks a second time first — see {@link DeleteButton}. */
  modifiedIds: Set<string>;
  /**
   * Runs that are still going on an instrument (`ZpcrStore.inProgressIds`). Their chips glow
   * rather than sitting on the bar's usual black, because a file that is still growing is a
   * different thing from one that is finished — it will have more cycles in it a minute from now.
   *
   * Nothing stores this. It is read from the archive's own `begun`/`ended` markers each render
   * (see core's `runProgressFromNames`), so it goes out on its own the moment the run watcher
   * pulls a snapshot carrying `ended`.
   */
  inProgressIds: Set<string>;
  /**
   * True while a run in progress on a connected instrument owns the whole bar — passed only by
   * the Instrument view's bar (see `App.tsx`'s `runActive`/`selectFile`), since that's the one
   * place a chip click could otherwise show something other than what the instrument is actually
   * running. Locks every chip but the active one, primary *and* auxiliary staging (magenta,
   * `stagedIds`) alike: an override staged over the run in progress isn't "the next run" the way
   * it is once the run finishes, it's a claim about the plate or protocol *this* run is using, so
   * leaving it clickable would be exactly the confusion the lock exists to prevent.
   */
  activeLocked?: boolean;
  /** What each file is called and when it ran, keyed by id (`ZpcrStore.experiments`). A chip
   * leads with the name and carries the timestamp underneath; the file name moves to the hover
   * card, where it is still one glance away. */
  experiments: Map<string, ExperimentIdentity>;
}

/** Fallback chip text for a file whose identity hasn't been resolved yet (a store map still
 * catching up with a just-added file) — the filename, minus the extension, as before. */
function fallbackLabel(f: LoadedFile): string {
  return f.name.replace(/\.(zpcr|pcrd|pltd|plt\.csv|csv|json)$/i, "");
}

/** Encryption status for a loaded file's icon color — mirrors the Overview panel's "Encrypted"
 * block (see `encryptionStatus.ts`): green (not encrypted), orange (encrypted, decrypted with
 * the current password), red (encrypted, not yet opened). */
function fileEncryptionStatus(
  f: LoadedFile,
  run: RunResult | undefined,
  plateFile: PlateFileResult | undefined,
  password: string,
): EncryptionStatus {
  if (f.kind === "pltd" || f.kind === "csv") return plateFileEncryptionStatus(plateFile, password);
  // A `.prcl.txt` is plaintext by definition — it is admitted only once it has parsed as one
  // (`useZpcrStore`'s `fileKind`), so there is no locked or failed state to show.
  if (f.kind === "prcl") return { kind: "none" };
  return runEncryptionStatus(run, password);
}

/** Chip badge: well count for a standalone plate file, or a lock/error/loading glyph while a
 * `.pcrd`/`.pltd`/run password is unresolved. Run chips (`.zpcr`/`.pcrd`) carry no badge once
 * loaded — their detail lives in the hover card instead. */
function meta(f: LoadedFile, run: RunResult | undefined, plateFile: PlateFileResult | undefined): string {
  // A protocol has no well count to report, and no longer needs the word "proto" either: the
  // chip's icon is what tells the two override kinds apart at a glance in the Instrument view.
  if (f.kind === "prcl") return "";
  if (f.kind === "pltd" || f.kind === "csv") {
    if (plateFile?.plate) return `${plateFile.plate.wells.filter((w) => w.loaded).length}w`;
    return plateFile?.needsPassword ? "🔒" : plateFile?.error ? "⚠" : "…";
  }
  if (!run?.zpcr) return run?.needsPassword ? "🔒" : run?.error ? "⚠" : "…";
  return "";
}

/** Hover card content: protocol name + cycle count for a run, plus the plate's target/sample
 * lists when a plate is attached (either the run's own, or a standalone `.pltd`/`.csv` chip's).
 * Rendered via portal at a fixed screen position (see {@link FileChip}) rather than as a normal
 * absolutely-positioned child, because `.filebar` scrolls horizontally (`overflow-x: auto`) and
 * would otherwise clip the card vertically too. */
function HoverCard({
  identity,
  run,
  plateFile,
  password,
  style,
}: {
  identity: ExperimentIdentity;
  run: RunResult | undefined;
  plateFile: PlateFileResult | undefined;
  password: string;
  style: React.CSSProperties;
}) {
  const zpcr = run?.zpcr;
  const plate = useMemo(() => {
    if (plateFile) return plateFile.plate;
    return zpcr?.plates(password || undefined)[0]?.pltd.plate ?? null;
  }, [zpcr, plateFile, password]);

  const protocolName = zpcr?.protocol()?.name;
  const cycles = zpcr?.reads.length;
  const targets = plate ? plateTargets(plate) : [];
  const samples = plate?.samples ?? [];

  return (
    <div className="filecard mono" style={style}>
      {/* The name leads, as it does on the chip — and the file it lives in follows, which is
          the question the chip no longer answers on its own. */}
      <div className="filecard__title">{identity.name}</div>
      <div className="filecard__file">{identity.fileName}</div>
      {zpcr && (
        <dl className="filecard__dl">
          <dt>Protocol</dt>
          <dd>{protocolName || "—"}</dd>
          <dt>Cycles</dt>
          <dd>{cycles ?? "—"}</dd>
        </dl>
      )}
      {plate && (
        <>
          <div className="filecard__section">
            <div className="filecard__label">Targets</div>
            {targets.length ? (
              <div className="filecard__chips">
                {targets.map((t) => (
                  <span
                    key={t.name}
                    className="filecard__chip"
                    style={t.channel != null ? { color: channelColor(t.channel) } : undefined}
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="filecard__empty">none</div>
            )}
          </div>
          <div className="filecard__section">
            <div className="filecard__label">Samples</div>
            {samples.length ? (
              <div className="filecard__chips">
                {samples.map((s) => (
                  <span key={s} className="filecard__chip">
                    {s}
                  </span>
                ))}
              </div>
            ) : (
              <div className="filecard__empty">none</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The chip's delete control, and the one place the file bar knows about unsaved work.
 *
 * A file the app loaded and never touched exists on the user's disk too, so removing it costs
 * nothing but a re-drop and the button deletes on the first click, as it always has. A file whose
 * content has been *edited* — a threshold moved, the run renamed, a plate attached — exists in
 * this form only in this browser until it's downloaded, so its ✕ arms instead: it becomes a waste
 * bin on red, and the click after that is the one that deletes.
 *
 * The armed state is deliberately cheap to escape — moving the pointer off the chip or pressing
 * Escape disarms it (see {@link FileChip}) — because it is a warning, not a modal: nothing
 * should be able to leave a red button sitting in the bar waiting for a stray click.
 */
function DeleteButton({
  name,
  modified,
  armed,
  onArm,
  onDelete,
}: {
  name: string;
  modified: boolean;
  armed: boolean;
  onArm: () => void;
  onDelete: () => void;
}) {
  return (
    <button
      className={"filechip__del" + (armed ? " is-armed" : "")}
      aria-label={
        armed
          ? `Confirm deleting ${name} — its unsaved changes will be lost`
          : `Delete ${name} from storage`
      }
      title={
        armed
          ? "Click again to delete. This file has changes that aren't on disk — download it first to keep them."
          : modified
            ? "Delete from storage — this file has changes that aren't on disk, so it will ask again"
            : "Delete from storage"
      }
      onClick={(e) => {
        e.stopPropagation();
        if (armed) onDelete();
        else onArm();
      }}
    >
      <span className="filechip__delglyph">{armed ? <TrashIcon /> : "✕"}</span>
      {/* The editor's universal "unsaved" dot, in the space under the ✕ that was empty anyway —
          so a modified chip announces itself before anyone reaches for the delete, and the bar
          neither grows nor reflows when it does. The slot is always there, just invisible
          (`app.css`), which is what keeps the ✕ from hopping as files are edited. */}
      <span className="filechip__moddot" aria-hidden="true" />
    </button>
  );
}

/** One file chip plus its hover card. The card is a fixed-position portal (see {@link HoverCard})
 * positioned from the chip's own bounding rect on hover, since `.filebar`'s horizontal scroll
 * clips a plain absolutely-positioned dropdown. */
function FileChip({
  f,
  identity,
  run,
  plateFile,
  password,
  isActive,
  isModified,
  isRunning,
  isStaged,
  activeLocked,
  onSelect,
  onRemove,
}: {
  f: LoadedFile;
  identity: ExperimentIdentity;
  run: RunResult | undefined;
  plateFile: PlateFileResult | undefined;
  password: string;
  isActive: boolean;
  /** See {@link Props.modifiedIds} — what makes this chip's delete a two-step. */
  isModified: boolean;
  /** See {@link Props.inProgressIds} — the run is still being written to. */
  isRunning: boolean;
  isStaged: boolean;
  /** See {@link Props.activeLocked}. */
  activeLocked: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const mainRef = useRef<HTMLButtonElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  // Armed = the confirm click is pending on this chip. A file that stops being modified (it was
  // just downloaded) can't stay armed, since there is no longer anything to confirm.
  const [armed, setArmed] = useState(false);
  const isArmed = armed && isModified;
  const encStatus = fileEncryptionStatus(f, run, plateFile, password);
  // A staging chip (protocol/plate override) locks along with the run chip: showing something
  // other than what the instrument is actually running is exactly the confusion the lock exists
  // to prevent, so there's no carve-out for "only the primary selection."
  const clickLocked = activeLocked && !isActive;

  return (
    <div
      className={
        "filechip" +
        (isActive ? " is-active" : "") +
        (isStaged && !isActive ? " is-staged" : "") +
        (isModified ? " is-modified" : "") +
        (isRunning ? " is-running" : "") +
        (isArmed ? " is-arming" : "") +
        (clickLocked ? " is-locked" : "")
      }
      onMouseLeave={() => setArmed(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setArmed(false);
      }}
    >
      <button
        ref={mainRef}
        className="filechip__main"
        role="tab"
        aria-selected={isActive || isStaged}
        title={
          clickLocked
            ? "Can't switch files while a run is in progress and connected via USB"
            : undefined
        }
        onClick={() => {
          if (!clickLocked) onSelect(f.id);
        }}
        onMouseEnter={() => {
          const r = mainRef.current?.getBoundingClientRect();
          if (r) setCardPos({ top: r.bottom + 6, left: r.left });
        }}
        onMouseLeave={() => setCardPos(null)}
        onFocus={() => {
          const r = mainRef.current?.getBoundingClientRect();
          if (r) setCardPos({ top: r.bottom + 6, left: r.left });
        }}
        onBlur={() => setCardPos(null)}
      >
        {/* Shape says what the file is (run / plate / protocol — the library's own grouping, so
            a `.pltd` and a `.plt.csv` look alike), colour says whether it's encrypted, which is
            what the dot this replaced said on its own. */}
        <span
          className={`filechip__icon filechip__icon--${encStatus.kind}`}
          title={`${CATEGORY_TEXT[fileCategory(f.kind)]} · ${ENCRYPTION_TEXT[encStatus.kind]}`}
        >
          <FileKindIcon kind={f.kind} />
        </span>
        {/* Two lines, so the chip is a name rather than a path: the run's name, and under it a
            compact local timestamp at a smaller, dimmer size. The full file name is in the
            hover card. */}
        <span className="filechip__text">
          <span className="filechip__name mono">{identity.name}</span>
          {identity.dateText && <span className="filechip__date mono">{identity.dateText}</span>}
        </span>
        <span className="filechip__meta mono">{meta(f, run, plateFile)}</span>
      </button>
      {cardPos &&
        createPortal(
          <HoverCard
            identity={identity}
            run={run}
            plateFile={plateFile}
            password={password}
            style={{ position: "fixed", top: cardPos.top, left: cardPos.left, zIndex: 50 }}
          />,
          document.body,
        )}
      <DeleteButton
        name={identity.name}
        modified={isModified}
        // An untouched file deletes on the first click: `armed` is only ever consulted for one
        // whose edits would go with it.
        armed={isArmed}
        onArm={() => (isModified ? setArmed(true) : void onRemove(f.id))}
        onDelete={() => void onRemove(f.id)}
      />
    </div>
  );
}

export function FileBar({
  files,
  runs,
  plateFiles,
  activeId,
  onSelect,
  onRemove,
  stagedIds,
  modifiedIds,
  inProgressIds,
  activeLocked,
  experiments,
}: Props) {
  const [password] = usePltdPassword();
  return (
    <div
      className={"filebar" + (stagedIds ? " filebar--multi" : "")}
      role="tablist"
      aria-label={stagedIds ? "Files for the run to start" : "Loaded files"}
      aria-multiselectable={stagedIds ? true : undefined}
    >
      {files.map((f) => (
        <FileChip
          key={f.id}
          f={f}
          identity={
            experiments.get(f.id) ?? {
              name: fallbackLabel(f),
              date: null,
              dateText: "",
              fileName: f.name,
            }
          }
          run={runs.get(f.id)}
          plateFile={plateFiles.get(f.id)}
          password={password}
          isActive={f.id === activeId}
          isStaged={stagedIds ? stagedIds.has(f.id) : false}
          isModified={modifiedIds.has(f.id)}
          isRunning={inProgressIds.has(f.id)}
          activeLocked={!!activeLocked}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
