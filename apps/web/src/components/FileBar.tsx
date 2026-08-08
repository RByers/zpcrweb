import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FileKind } from "@zpcrweb/core";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import { usePltdPassword } from "../state/pltdPassword";
import { fluorColor } from "../lib/fluorColors";
import {
  plateFileEncryptionStatus,
  runEncryptionStatus,
  type EncryptionStatus,
} from "../lib/encryptionStatus";
import type { ExperimentIdentity } from "../lib/experiment";
import { fileCategory, fileKindDescription, plateTargets, type FileCategory } from "@zpcrweb/core";
import { FileKindIcon } from "./FileIcons";

/** Tooltip wording for the chip icon — its shape, then its colour. */
const CATEGORY_TEXT: Record<FileCategory, string> = {
  run: "Run",
  plate: "Plate map",
  protocol: "Thermal protocol",
  report: "Run report",
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
   * Usually `ZpcrStore.activeName`, the file every view is pointed at; in the Instrument view,
   * which shows no file, it is the run being staged (`App.tsx`). */
  activeName: string | null;
  onSelect: (id: string) => void;
  /**
   * A chip's ✕: **release** this file (`FileSettings.loaded = false`) — its bytes leave memory and
   * its chip leaves the bar; the file itself stays in IndexedDB and in the full files table (the
   * "Files" tab, `FilesTableView.tsx`), described there by its cached summary. There is no confirm,
   * because nothing is at risk: the file is one click of that tab away from being back.
   */
  onUnload: (id: string) => void;
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
   * Runs that stopped short of their protocol (`ZpcrStore.incompleteIds`). Their chips say
   * **Incomplete** in red where the run's date would go — the date is the least load-bearing
   * thing on a chip, and "this run didn't finish" is the most, so the one takes the other's slot
   * rather than making the chip taller. See core's `runCompleteness` for why a read count is
   * what says this.
   */
  incompleteIds: Set<string>;
  /**
   * Experiments prepared but never started (`ZpcrStore.pendingIds`). Their chips say **Pending**
   * where the date would go, the same slot **Incomplete** uses and for the same reason — but in the
   * magenta the app uses for the instrument, since this is a file on its way *to* one rather than a
   * run that went wrong. The two states are worth telling apart precisely because both hold fewer
   * reads than their protocol asks for: one was started and stopped short, the other hasn't run.
   */
  pendingIds: Set<string>;
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
  // (`useZpcrStore`'s `fileKind`), so there is no locked or failed state to show. An `.alf` report
  // is the same: plain text, admitted only once `parseAlf` has read it.
  if (f.kind === "prcl" || f.kind === "alf") return { kind: "none" };
  return runEncryptionStatus(run, password);
}

/** A standalone plate file's well count — `24 wells` — rendered as the chip's second line, in
 * the same slot and style as a run's date (`identity.dateText`): the two are mutually exclusive
 * (a `.pltd`/`.csv` carries no run date), so they share `filechip__date` rather than each
 * getting their own rule. */
function wellsText(f: LoadedFile, plateFile: PlateFileResult | undefined): string {
  if ((f.kind === "pltd" || f.kind === "csv") && plateFile?.plate) {
    const n = plateFile.plate.wells.filter((w) => w.loaded).length;
    return `${n} well${n === 1 ? "" : "s"}`;
  }
  return "";
}

/** Chip badge: a lock/error/loading glyph while a `.pcrd`/`.pltd`/run password is unresolved.
 * Run chips (`.zpcr`/`.pcrd`) carry no badge once loaded — their detail lives in the hover card
 * instead — and a loaded plate file's badge is its well count, shown below the name instead (see
 * {@link wellsText}). */
function meta(f: LoadedFile, run: RunResult | undefined, plateFile: PlateFileResult | undefined): string {
  // A protocol has no well count to report, and no longer needs the word "proto" either: the
  // chip's icon is what tells the two override kinds apart at a glance in the Instrument view.
  // A report has none either, and its own detail is its Overview.
  if (f.kind === "prcl" || f.kind === "alf") return "";
  if (f.kind === "pltd" || f.kind === "csv") {
    if (plateFile?.plate) return "";
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
  kind,
  identity,
  run,
  plateFile,
  password,
  style,
}: {
  kind: FileKind;
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
      <div className="filecard__type">{fileKindDescription(kind)}</div>
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
                    style={t.fluor != null ? { color: fluorColor(t.fluor) } : undefined}
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
 * The chip's ✕: releases the file, nothing more — see {@link Props.onUnload}. There is no
 * confirm, unlike the old two-click delete this replaced, because there is nothing to lose: the
 * file stays in IndexedDB and in the full files table.
 *
 * Still carries the "unsaved" dot in the space under the ✕: a modified file announcing itself is
 * still useful here, it's just no longer what gates this particular button.
 */
function UnloadButton({ name, onUnload }: { name: string; onUnload: () => void }) {
  return (
    <button
      className="filechip__del"
      aria-label={`Close ${name}`}
      title="Close — releases the file from memory; it stays in storage, see the Files tab to reopen or delete it"
      onClick={(e) => {
        e.stopPropagation();
        onUnload();
      }}
    >
      <span className="filechip__delglyph">✕</span>
      {/* The editor's universal "unsaved" dot, in the space under the ✕ that was empty anyway —
          so a modified chip announces itself, and the bar neither grows nor reflows when it does.
          The slot is always there, just invisible (`app.css`), which is what keeps the ✕ from
          hopping as files are edited. */}
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
  isIncomplete,
  isPending,
  onSelect,
  onUnload,
}: {
  f: LoadedFile;
  identity: ExperimentIdentity;
  run: RunResult | undefined;
  plateFile: PlateFileResult | undefined;
  password: string;
  isActive: boolean;
  /** See {@link Props.modifiedIds} — the "unsaved" dot under the ✕. */
  isModified: boolean;
  /** See {@link Props.inProgressIds} — the run is still being written to. */
  isRunning: boolean;
  /** See {@link Props.incompleteIds} — the run ended without finishing its protocol. */
  isIncomplete: boolean;
  /** See {@link Props.pendingIds} — the experiment has not been started. */
  isPending: boolean;
  onSelect: (id: string) => void;
  onUnload: (id: string) => void;
}) {
  const mainRef = useRef<HTMLButtonElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const encStatus = fileEncryptionStatus(f, run, plateFile, password);

  return (
    <div
      className={
        "filechip" +
        (isActive ? " is-active" : "") +
        (isModified ? " is-modified" : "") +
        (isRunning ? " is-running" : "")
      }
    >
      <button
        ref={mainRef}
        className="filechip__main"
        role="tab"
        aria-selected={isActive}
        onClick={() => onSelect(f.name)}
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
            compact local timestamp at a smaller, dimmer size — or, for a standalone plate file
            (which has no run date), its well count in that same slot instead. The full file name
            is in the hover card. */}
        <span className="filechip__text">
          <span className="filechip__name mono">{identity.name}</span>
          {/* Either state displaces the date rather than joining it: which of the two a file is in
              is the thing to notice about it, and when it ran is still in the hover card. A pending
              experiment has no run date to displace anyway — it hasn't run. */}
          {isPending ? (
            <span className="filechip__date filechip__date--pending mono">Pending</span>
          ) : isIncomplete ? (
            <span className="filechip__date filechip__date--incomplete mono">Incomplete</span>
          ) : (
            identity.dateText && <span className="filechip__date mono">{identity.dateText}</span>
          )}
          {wellsText(f, plateFile) && (
            <span className="filechip__date mono">{wellsText(f, plateFile)}</span>
          )}
        </span>
        <span className="filechip__meta mono">{meta(f, run, plateFile)}</span>
      </button>
      {cardPos &&
        createPortal(
          <HoverCard
            kind={f.kind}
            identity={identity}
            run={run}
            plateFile={plateFile}
            password={password}
            style={{ position: "fixed", top: cardPos.top, left: cardPos.left, zIndex: 50 }}
          />,
          document.body,
        )}
      <UnloadButton name={identity.name} onUnload={() => onUnload(f.name)} />
    </div>
  );
}

export function FileBar({
  files,
  runs,
  plateFiles,
  activeName,
  onSelect,
  onUnload,
  modifiedIds,
  inProgressIds,
  incompleteIds,
  pendingIds,
  experiments,
}: Props) {
  const [password] = usePltdPassword();
  return (
    <div
      className="filebar"
      role="tablist"
      aria-label="Loaded files"
    >
      {files.map((f) => (
        <FileChip
          key={f.name}
          f={f}
          identity={
            experiments.get(f.name) ?? {
              name: fallbackLabel(f),
              named: false,
              date: null,
              dateText: "",
              fileName: f.name,
            }
          }
          run={runs.get(f.name)}
          plateFile={plateFiles.get(f.name)}
          password={password}
          isActive={f.name === activeName}
          isModified={modifiedIds.has(f.name)}
          isRunning={inProgressIds.has(f.name)}
          isIncomplete={incompleteIds.has(f.name)}
          isPending={pendingIds.has(f.name)}
          onSelect={onSelect}
          onUnload={onUnload}
        />
      ))}
    </div>
  );
}
