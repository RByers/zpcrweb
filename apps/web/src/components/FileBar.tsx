import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import { downloadBytes } from "../lib/download";
import { DownloadIcon } from "./DownloadIcon";

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

/** Chip badge: cycle count for a run, well count for a standalone plate file, or a lock/error/
 * loading glyph while a `.pcrd`/`.pltd` password is unresolved. */
function meta(f: LoadedFile, run: RunResult | undefined, plateFile: PlateFileResult | undefined): string {
  if (f.kind === "pltd" || f.kind === "csv") {
    if (plateFile?.plate) return `${plateFile.plate.wells.filter((w) => w.loaded).length}w`;
    return plateFile?.needsPassword ? "🔒" : plateFile?.error ? "⚠" : "…";
  }
  if (!run?.zpcr) return run?.needsPassword ? "🔒" : run?.error ? "⚠" : "…";
  return `${run.zpcr.reads.length}c`;
}

export function FileBar({ files, runs, plateFiles, activeId, onSelect, onRemove }: Props) {
  return (
    <div className="filebar" role="tablist" aria-label="Loaded files">
      {files.map((f) => {
        const run = runs.get(f.id);
        const plateFile = plateFiles.get(f.id);
        return (
          <div
            key={f.id}
            className={"filechip" + (f.id === activeId ? " is-active" : "")}
          >
            <button
              className="filechip__main"
              role="tab"
              aria-selected={f.id === activeId}
              onClick={() => onSelect(f.id)}
              title={f.name}
            >
              <span className="filechip__dot" />
              <span className="filechip__name mono">{label(f)}</span>
              <span className="filechip__meta mono">{meta(f, run, plateFile)}</span>
            </button>
            <button
              className="filechip__dl"
              aria-label={`Download ${f.name}`}
              title="Download original file"
              onClick={(e) => {
                e.stopPropagation();
                downloadBytes(f.name, f.bytes);
              }}
            >
              <DownloadIcon />
            </button>
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
      })}
    </div>
  );
}
