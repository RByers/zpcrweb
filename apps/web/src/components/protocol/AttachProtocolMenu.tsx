import { useEffect, useRef, useState } from "react";
import type { AttachSource } from "../../lib/attachSources";
import { UploadIcon } from "../ViewIcons";

interface Props {
  /** Every protocol this browser is holding — standalone `.prcl.txt` files *and* the protocol
   * inside any other loaded run; see `lib/attachSources.ts`. */
  sources: AttachSource[];
  compactLabel: string;
  /** Bare icon in a box instead of a labelled chip, with the label as its tooltip — see
   * `AttachPlateMenu`'s `iconOnly`, which this mirrors. */
  iconOnly?: boolean;
  /** True when a protocol is already attached, so choosing another discards it — the menu asks
   * for confirmation first, exactly as `AttachPlateMenu` does for a plate. */
  confirmReplace: boolean;
  /** Attach these bytes, whether they came off the list or off the disk. */
  onAttach: (file: File) => void;
}

/** A choice awaiting confirmation before it's actually applied. */
interface Pending {
  name: string;
  commit: () => void;
}

/**
 * "Attach/replace protocol" control — the protocol-side mirror of `plate/AttachPlateMenu.tsx`, and
 * deliberately the same `<details>` menu with the same options, so attaching either half of an
 * experiment works the same way. That includes what it lists: **protocols, not protocol files** —
 * the one inside a run that has already happened is offered by name, which is the common case,
 * since re-running a protocol is what a past run's protocol is for.
 *
 * This is the "use a protocol I already have" half of getting one. Writing a new one is its own
 * button beside this (`OverviewView`'s `ExperimentParts`) rather than an item in here: it used to be
 * a "New protocol…" option inside this menu, complete with a file-name form, which buried the more
 * common of the two actions inside the less common one and asked for a name before there was
 * anything to name.
 */
export function AttachProtocolMenu({
  sources,
  compactLabel,
  iconOnly,
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
            {sources.length === 0 ? (
              <button className="dlmenu__item mono" disabled>
                No other protocols loaded yet
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
        accept=".prcl.txt,.txt"
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
