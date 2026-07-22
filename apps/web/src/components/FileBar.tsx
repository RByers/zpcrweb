import type { LoadedFile } from "../state/useZpcrStore";

interface Props {
  files: LoadedFile[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void | Promise<void>;
}

/** Shorten `20260720_211747_CT019138_Luna_noRT.zpcr` to something legible. */
function label(f: LoadedFile): string {
  return f.zpcr.metadata.dataFile || f.name.replace(/\.zpcr$/i, "");
}

export function FileBar({ files, activeId, onSelect, onRemove }: Props) {
  return (
    <div className="filebar" role="tablist" aria-label="Loaded files">
      {files.map((f) => (
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
            <span className="filechip__meta mono">{f.zpcr.reads.length}c</span>
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
      ))}
    </div>
  );
}
