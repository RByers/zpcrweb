import { useEffect, useRef, useState } from "react";
import type { LoadedFile } from "../../state/useZpcrStore";
import { UploadIcon } from "../ViewIcons";

interface Props {
  /** Every loaded file — filtered down to `.prcl.txt` entries to list. */
  files: LoadedFile[];
  compactLabel: string;
  /** True when a protocol is already attached, so choosing another discards it — the menu asks
   * for confirmation first, exactly as `AttachPlateMenu` does for a plate. */
  confirmReplace: boolean;
  /** Attach one of the already-loaded protocol files. */
  onSelect: (file: LoadedFile) => void;
  /** Attach a protocol picked fresh from disk. */
  onUpload: (file: File) => void;
}

/** A choice awaiting confirmation before it's actually applied. */
interface Pending {
  name: string;
  commit: () => void;
}

/**
 * "Attach/replace protocol" control — the protocol-side mirror of `plate/AttachPlateMenu.tsx`, and
 * deliberately the same `<details>` menu with the same options, so attaching either half of an
 * experiment works the same way.
 *
 * This is the "use a protocol I already have" half of getting one. Writing a new one is its own
 * button beside this (`OverviewView`'s `ExperimentParts`) rather than an item in here: it used to be
 * a "New protocol…" option inside this menu, complete with a file-name form, which buried the more
 * common of the two actions inside the less common one and asked for a name before there was
 * anything to name.
 */
export function AttachProtocolMenu({
  files,
  compactLabel,
  confirmReplace,
  onSelect,
  onUpload,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const protocolFiles = files.filter((f) => f.kind === "prcl");

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setPending(null);
  };

  // A native <details> only closes on a second click on its own <summary> — a click anywhere else
  // outside it just leaves it hanging open. Same dismissal `AttachPlateMenu` does, and for the same
  // reason: a menu showing a "replace?" prompt should be easy to walk away from.
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
              Replace this experiment's protocol with <strong>{pending.name}</strong>? The current
              protocol can't be recovered unless it's been cloned or downloaded first.
            </div>
            <button
              className="dlmenu__item dlmenu__item--danger mono"
              onClick={() => {
                pending.commit();
                close();
              }}
            >
              Replace protocol
            </button>
            <button className="dlmenu__item mono" onClick={() => setPending(null)}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {protocolFiles.length === 0 ? (
              <button className="dlmenu__item mono" disabled>
                No protocol files loaded yet
              </button>
            ) : (
              protocolFiles.map((f) => (
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
        accept=".prcl.txt,.txt"
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
