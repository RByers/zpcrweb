import { useRef } from "react";
import type { LoadedFile } from "../../state/useZpcrStore";
import { UploadIcon } from "../ViewIcons";

interface Props {
  /** Every loaded file — filtered down to `.pltd`/`.plt.csv` entries to list. */
  files: LoadedFile[];
  compactLabel: string;
  disabled?: boolean;
  disabledTitle?: string;
  /** Attach one of the already-loaded plate files. */
  onSelect: (file: LoadedFile) => void;
  /** Attach a plate picked fresh from disk. */
  onUpload: (file: File) => void;
}

/**
 * "Attach/replace plate" control: a `<details>` menu (styled like `PlateDownloadButton`'s)
 * offering every already-loaded standalone plate file (`.pltd`/`.plt.csv`) plus an upload
 * option, in place of the old plain file-picker `DropZone`. Cloning a plate out of a run (see
 * `PlateDownloadButton`'s Clone button) is what typically populates the list this reads from.
 */
export function AttachPlateMenu({ files, compactLabel, disabled, disabledTitle, onSelect, onUpload }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const plateFiles = files.filter((f) => f.kind === "pltd" || f.kind === "csv");

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  if (disabled) {
    return (
      <div className="dropzone dropzone--disabled" title={disabledTitle} aria-disabled="true">
        <span className="dropzone__compact mono">
          <UploadIcon />
          <span className="dropzone__compact-label">{compactLabel}</span>
        </span>
      </div>
    );
  }

  return (
    <details className="dlmenu" ref={detailsRef}>
      <summary className="dropzone" title={compactLabel} aria-label={compactLabel}>
        <span className="dropzone__compact mono">
          <UploadIcon />
          <span className="dropzone__compact-label">{compactLabel}</span>
        </span>
      </summary>
      <div className="dlmenu__list">
        {plateFiles.length === 0 ? (
          <button className="dlmenu__item mono" disabled>
            No plate files loaded yet
          </button>
        ) : (
          plateFiles.map((f) => (
            <button
              key={f.id}
              className="dlmenu__item mono"
              title={f.name}
              onClick={() => {
                onSelect(f);
                close();
              }}
            >
              {f.name}
            </button>
          ))
        )}
        <button className="dlmenu__item mono" onClick={() => inputRef.current?.click()}>
          Upload…
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pltd,.csv,.plt.csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onUpload(file);
          e.target.value = "";
          close();
        }}
      />
    </details>
  );
}
