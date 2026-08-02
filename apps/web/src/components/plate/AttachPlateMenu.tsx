import { useEffect, useRef, useState } from "react";
import type { LoadedFile } from "../../state/useZpcrStore";
import { UploadIcon } from "../ViewIcons";

interface Props {
  /** Every loaded file — filtered down to `.pltd`/`.plt.csv` entries to list. */
  files: LoadedFile[];
  compactLabel: string;
  disabled?: boolean;
  disabledTitle?: string;
  /** True when a plate is already attached, so choosing a replacement discards it — the menu
   * asks for confirmation first. False for "attach plate" on a run with no plate yet, where
   * there's nothing to lose and the choice takes effect immediately. */
  confirmReplace: boolean;
  /** Attach one of the already-loaded plate files. */
  onSelect: (file: LoadedFile) => void;
  /** Attach a plate picked fresh from disk. */
  onUpload: (file: File) => void;
}

/** A choice awaiting confirmation before it's actually applied. */
interface Pending {
  name: string;
  commit: () => void;
}

/**
 * "Attach/replace plate" control: a `<details>` menu (styled like `PlateDownloadButton`'s)
 * offering every already-loaded standalone plate file (`.pltd`/`.plt.csv`) plus an upload
 * option, in place of the old plain file-picker `DropZone`. Cloning a plate out of a run (see
 * `PlateDownloadButton`'s Clone button) is what typically populates the list this reads from.
 *
 * When `confirmReplace` is set, picking a file (from the list or via upload) doesn't attach it
 * right away — it swaps the list for a "replace with this?" prompt, since attaching overwrites
 * whatever plate layout is already there with no way to get it back short of re-attaching the
 * old one.
 */
export function AttachPlateMenu({
  files,
  compactLabel,
  disabled,
  disabledTitle,
  confirmReplace,
  onSelect,
  onUpload,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const plateFiles = files.filter((f) => f.kind === "pltd" || f.kind === "csv");

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setPending(null);
  };

  // A native <details> only closes on a second click on its own <summary> — a click anywhere
  // else outside it just leaves it hanging open. Close it like any other dismissable popover,
  // rather than requiring a second click on the toggle to back out — especially important once
  // it's showing a "replace?" prompt, which should be easy to walk away from.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const choose = (name: string, commit: () => void) => {
    if (confirmReplace) setPending({ name, commit });
    else {
      commit();
      close();
    }
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
      <summary
        className="dropzone"
        title={compactLabel}
        aria-label={compactLabel}
        onClick={() => setPending(null)}
      >
        <span className="dropzone__compact mono">
          <UploadIcon />
          <span className="dropzone__compact-label">{compactLabel}</span>
        </span>
      </summary>
      <div className="dlmenu__list dlmenu__list--wide">
        {pending ? (
          <>
            <div className="dlmenu__confirm mono">
              Replace the current plate layout with <strong>{pending.name}</strong>? The current
              layout can't be recovered unless it's been cloned or downloaded first.
            </div>
            <button
              className="dlmenu__item dlmenu__item--danger mono"
              onClick={() => {
                pending.commit();
                close();
              }}
            >
              Replace plate
            </button>
            <button className="dlmenu__item mono" onClick={() => setPending(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
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
                  onClick={() => choose(f.name, () => onSelect(f))}
                >
                  {f.name}
                </button>
              ))
            )}
            <button className="dlmenu__item mono" onClick={() => inputRef.current?.click()}>
              Upload…
            </button>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".pltd,.csv,.plt.csv"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) choose(file.name, () => onUpload(file));
        }}
      />
    </details>
  );
}
