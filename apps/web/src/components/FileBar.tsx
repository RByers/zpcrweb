import type { LoadedFile, RunResult } from "../state/useZpcrStore";

interface Props {
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}

/** Shorten `20260720_211747_CT019138_Luna_noRT.zpcr` to something legible. */
function label(f: LoadedFile, run: RunResult | undefined): string {
  return run?.zpcr?.metadata.dataFile || f.name.replace(/\.(zpcr|pcrd)$/i, "");
}

export function FileBar({ files, runs, activeId, onSelect, onRemove }: Props) {
  return (
    <div className="filebar" role="tablist" aria-label="Loaded files">
      {files.map((f) => {
        const run = runs.get(f.id);
        const locked = !run?.zpcr;
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
              <span className="filechip__name mono">{label(f, run)}</span>
              <span className="filechip__meta mono">
                {locked ? (run?.needsPassword ? "🔒" : run?.error ? "⚠" : "…") : `${run.zpcr!.reads.length}c`}
              </span>
            </button>
            <button
              className="filechip__del"
              aria-label={`Delete ${label(f, run)} from storage`}
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
