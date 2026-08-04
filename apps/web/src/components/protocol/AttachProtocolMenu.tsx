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
  /** Create a new, empty `.prcl.txt` under this name and attach it — see {@link NewProtocolForm}. */
  onCreate: (fileName: string) => void;
}

/** A choice awaiting confirmation before it's actually applied. */
interface Pending {
  name: string;
  commit: () => void;
}

/**
 * "Attach/replace protocol" control — the protocol-side mirror of `plate/AttachPlateMenu.tsx`, and
 * deliberately the same `<details>` menu with the same three-plus-one options, so attaching either
 * half of an experiment works the same way.
 *
 * The one thing it has that the plate menu doesn't is **New protocol**, which asks for a file name
 * and creates an empty `.prcl.txt` under it. That is for the case where the protocol is meant to
 * outlive this experiment — a reusable file of its own, named and downloadable. It is *not* the
 * only way to get a protocol, and not the shortest: a pending experiment's Protocol tab is already
 * an editor over a blank default (see `ProtocolView`), so someone who just wants to type a protocol
 * for this one run never needs this menu at all.
 */
export function AttachProtocolMenu({
  files,
  compactLabel,
  confirmReplace,
  onSelect,
  onUpload,
  onCreate,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** True while the "New protocol" name field is showing, in place of the list. */
  const [naming, setNaming] = useState(false);
  const protocolFiles = files.filter((f) => f.kind === "prcl");

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setPending(null);
    setNaming(false);
  };

  // A native <details> only closes on a second click on its own <summary> — a click anywhere else
  // outside it just leaves it hanging open. Same dismissal `AttachPlateMenu` does, and for the same
  // reason: a menu showing a "replace?" prompt or a half-typed name should be easy to walk away
  // from.
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
        onClick={() => {
          setPending(null);
          setNaming(false);
        }}
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
        ) : naming ? (
          <NewProtocolForm
            onCancel={() => setNaming(false)}
            onCreate={(fileName) => {
              // No `choose` here: a protocol that doesn't exist yet can't be the thing you regret
              // replacing — and it is about to be created either way, so the confirmation would be
              // asking about the wrong object.
              onCreate(fileName);
              close();
            }}
          />
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
            <button className="dlmenu__item mono" onClick={() => setNaming(true)}>
              New protocol…
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

/**
 * The name field behind "New protocol…". A file name is required — that is the point of this
 * option as against simply typing on the Protocol tab, which needs no file — so the create button
 * stays disabled until there is one, and `.prcl.txt` is appended when it's left off rather than
 * insisted upon.
 */
function NewProtocolForm({
  onCreate,
  onCancel,
}: {
  onCreate: (fileName: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const fileName = /\.prcl\.txt$/i.test(trimmed) ? trimmed : `${trimmed}.prcl.txt`;

  return (
    <>
      <div className="dlmenu__confirm mono">Name the new protocol file:</div>
      <input
        className="overview__filename-input mono"
        value={name}
        autoFocus
        placeholder="e.g. RVP fast"
        spellCheck={false}
        aria-label="New protocol file name"
        onChange={(e) => setName(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed) onCreate(fileName);
          if (e.key === "Escape") onCancel();
        }}
      />
      <button
        className="dlmenu__item mono"
        disabled={!trimmed}
        title={trimmed ? `Create ${fileName}` : "A file name is required"}
        onClick={() => onCreate(fileName)}
      >
        Create {trimmed ? fileName : "protocol"}
      </button>
      <button className="dlmenu__item mono" onClick={onCancel}>
        Cancel
      </button>
    </>
  );
}
