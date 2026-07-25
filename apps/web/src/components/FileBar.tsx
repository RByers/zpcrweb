import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import { usePltdPassword } from "../state/pltdPassword";
import { channelColor } from "../lib/channelColors";
import { plateTargets } from "../lib/plateTargets";
import {
  plateFileEncryptionStatus,
  runEncryptionStatus,
  type EncryptionStatus,
} from "../lib/encryptionStatus";

interface Props {
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}

/** Shorten `20260720_211747_CT019138_Luna_noRT.zpcr` to something legible. */
function label(f: LoadedFile): string {
  return f.name.replace(/\.(zpcr|pcrd|pltd|plt\.csv|csv)$/i, "");
}

/** Encryption status for a loaded file's dot color — mirrors the Overview panel's "Encrypted"
 * block (see `encryptionStatus.ts`): green (not encrypted), orange (encrypted, decrypted with
 * the current password), red (encrypted, not yet opened). */
function fileEncryptionStatus(
  f: LoadedFile,
  run: RunResult | undefined,
  plateFile: PlateFileResult | undefined,
  password: string,
): EncryptionStatus {
  if (f.kind === "pltd" || f.kind === "csv") return plateFileEncryptionStatus(plateFile, password);
  return runEncryptionStatus(run, password);
}

/** Chip badge: well count for a standalone plate file, or a lock/error/loading glyph while a
 * `.pcrd`/`.pltd`/run password is unresolved. Run chips (`.zpcr`/`.pcrd`) carry no badge once
 * loaded — their detail lives in the hover card instead. */
function meta(f: LoadedFile, run: RunResult | undefined, plateFile: PlateFileResult | undefined): string {
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
  fileName,
  run,
  plateFile,
  password,
  style,
}: {
  fileName: string;
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
      <div className="filecard__title">{fileName}</div>
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

/** One file chip plus its hover card. The card is a fixed-position portal (see {@link HoverCard})
 * positioned from the chip's own bounding rect on hover, since `.filebar`'s horizontal scroll
 * clips a plain absolutely-positioned dropdown. */
function FileChip({
  f,
  run,
  plateFile,
  password,
  isActive,
  onSelect,
  onRemove,
}: {
  f: LoadedFile;
  run: RunResult | undefined;
  plateFile: PlateFileResult | undefined;
  password: string;
  isActive: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}) {
  const mainRef = useRef<HTMLButtonElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const encStatus = fileEncryptionStatus(f, run, plateFile, password);

  return (
    <div className={"filechip" + (isActive ? " is-active" : "")}>
      <button
        ref={mainRef}
        className="filechip__main"
        role="tab"
        aria-selected={isActive}
        onClick={() => onSelect(f.id)}
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
        <span className={`filechip__dot filechip__dot--${encStatus.kind}`} />
        <span className="filechip__name mono">{label(f)}</span>
        <span className="filechip__meta mono">{meta(f, run, plateFile)}</span>
      </button>
      {cardPos &&
        createPortal(
          <HoverCard
            fileName={f.name}
            run={run}
            plateFile={plateFile}
            password={password}
            style={{ position: "fixed", top: cardPos.top, left: cardPos.left, zIndex: 50 }}
          />,
          document.body,
        )}
      <button
        className="filechip__del"
        aria-label={`Delete ${label(f)} from storage`}
        title="Delete from storage"
        onClick={(e) => {
          e.stopPropagation();
          void onRemove(f.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

export function FileBar({ files, runs, plateFiles, activeId, onSelect, onRemove }: Props) {
  const [password] = usePltdPassword();
  return (
    <div className="filebar" role="tablist" aria-label="Loaded files">
      {files.map((f) => (
        <FileChip
          key={f.id}
          f={f}
          run={runs.get(f.id)}
          plateFile={plateFiles.get(f.id)}
          password={password}
          isActive={f.id === activeId}
          onSelect={onSelect}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
