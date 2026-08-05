import { useEffect, useRef, useState } from "react";
import type { AttachSource } from "../../lib/attachSources";
import { UploadIcon } from "../ViewIcons";

interface Props {
  /** Every plate this browser is holding — standalone files *and* plates inside other loaded
   * runs; see `lib/attachSources.ts`, which builds the list and owns what "a plate" means here. */
  sources: AttachSource[];
  compactLabel: string;
  /** Shrink the trigger to a bare icon in a box, the shape every other button on a view's toolbar
   * has (`raw__download`) — the label survives as the tooltip. For the Plates/Protocol toolbars,
   * where this sits beside download and clone and a labelled chip made it read as a different
   * class of control. Overview's "Experiment parts" cards keep the labelled trigger: there it is
   * the card's main action, with room for words and no icon row to match. */
  iconOnly?: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  /** True when a plate is already attached, so choosing a replacement discards it — the menu
   * asks for confirmation first. False for "attach plate" on a run with no plate yet, where
   * there's nothing to lose and the choice takes effect immediately. */
  confirmReplace: boolean;
  /** Attach these bytes — one call for both routes in, since a plate picked off the list and one
   * picked off the disk are the same act by the time they get here. */
  onAttach: (file: File) => void;
}

/** A choice awaiting confirmation before it's actually applied. */
interface Pending {
  name: string;
  commit: () => void;
}

/**
 * "Attach/replace plate" control: a `<details>` menu (styled like `PlateDownloadButton`'s)
 * offering every plate already in the browser plus an upload option, in place of the old plain
 * file-picker `DropZone`.
 *
 * **What it lists is plates, not plate files.** A plate sitting inside a loaded run is offered
 * alongside the standalone `.pltd`/`.plt.csv` files, labelled by its own name with the run it
 * lives in beneath — see `lib/attachSources.ts`. Cloning a plate out of a run first (see
 * `PlateDownloadButton`'s Clone button) still makes a genuinely independent file, but it is no
 * longer the toll you pay to re-use a layout.
 *
 * When `confirmReplace` is set, picking a source (from the list or via upload) doesn't attach it
 * right away — it swaps the list for a "replace with this?" prompt, since attaching overwrites
 * whatever plate layout is already there with no way to get it back short of re-attaching the
 * old one.
 */
export function AttachPlateMenu({
  sources,
  compactLabel,
  iconOnly,
  disabled,
  disabledTitle,
  confirmReplace,
  onAttach,
}: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);

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
    // A real disabled <button> in the icon shape, so it greys out through `.raw__download:disabled`
    // like the download and clone buttons it sits with, rather than needing a rule of its own.
    return iconOnly ? (
      <button className="raw__download" disabled title={disabledTitle} aria-label={compactLabel}>
        <UploadIcon />
      </button>
    ) : (
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
        className={iconOnly ? "raw__download" : "dropzone"}
        title={compactLabel}
        aria-label={compactLabel}
        onClick={() => setPending(null)}
      >
        {iconOnly ? (
          <UploadIcon />
        ) : (
          <span className="dropzone__compact mono">
            <UploadIcon />
            <span className="dropzone__compact-label">{compactLabel}</span>
          </span>
        )}
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
            {sources.length === 0 ? (
              <button className="dlmenu__item mono" disabled>
                No other plates loaded yet
              </button>
            ) : (
              sources.map((s) => (
                <button
                  key={s.key}
                  className="dlmenu__item mono"
                  title={s.from ? `${s.label} — in ${s.from}` : s.label}
                  onClick={() => choose(s.label, () => onAttach(s.file()))}
                >
                  {s.label}
                  {s.from && <span className="dlmenu__from">in {s.from}</span>}
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
          if (file) choose(file.name, () => onAttach(file));
        }}
      />
    </details>
  );
}
