/**
 * The type chips over a list of files: one per kind of file the list actually holds, carrying how
 * many there are of it, each a toggle.
 *
 * **A filter, not a selection.** With no chip on, the list is whole — which is the state it opens
 * in, and the state turning the last chip off returns to — so there is no "All" control to keep in
 * step with the chips beside it. Only kinds actually present get a chip, which makes the bar a
 * summary of what is in front of you as much as a control, and lets the caller drop it entirely
 * when everything is the same kind.
 *
 * It sits over the **folder's file list** (`FolderSection.tsx`), which is where a filter earns its
 * place: that list is a directory on disk, possibly a very long one, and the job it exists for is
 * finding the file you want to open out of it. The catalog table above is what the app already
 * holds — a list you chose, one file at a time.
 */
import { fileKindDescription, type FileKind } from "@zpcrweb/core";
import { FileKindIcon } from "./FileIcons";

/**
 * The extension a kind is actually decoded as — independent of what the source file was named.
 * A `.csv` uploaded as `myplate.csv` is still a `.plt.csv` by content (`fileKind`'s content
 * sniffing), and a `.txt` is only ever admitted once it parses as a run definition, so this is the
 * kind's own canonical extension rather than any one file's.
 */
export const EXTENSION_TEXT: Record<FileKind, string> = {
  zpcr: "zpcr",
  pcrd: "pcrd",
  biomeme: "bmrun",
  pltd: "pltd",
  csv: "plt.csv",
  prcl: "prcl.txt",
  alf: "alf",
};

/** Count the kinds in a list, in extension order so the chips read in a stable order rather than
 * in whatever order the directory came back in. */
export function countKinds<T>(items: readonly T[], kindOf: (item: T) => FileKind | null) {
  const counts = new Map<FileKind, number>();
  for (const item of items) {
    const kind = kindOf(item);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => EXTENSION_TEXT[a[0]].localeCompare(EXTENSION_TEXT[b[0]]));
}

export function KindFilter({
  counts,
  on,
  onToggle,
}: {
  /** Kind and how many, from {@link countKinds}. */
  counts: readonly (readonly [FileKind, number])[];
  on: ReadonlySet<FileKind>;
  onToggle: (kind: FileKind) => void;
}) {
  return (
    <div className="kindfilter" role="group" aria-label="Filter by file type">
      {counts.map(([kind, count]) => {
        const isOn = on.has(kind);
        return (
          <button
            key={kind}
            type="button"
            className={"btn btn--sm kindfilter__chip" + (isOn ? " is-on" : "")}
            aria-pressed={isOn}
            title={
              fileKindDescription(kind) +
              (isOn ? " — click to stop showing only these" : " — click to show only these")
            }
            onClick={() => onToggle(kind)}
          >
            <span className="kindfilter__icon">
              <FileKindIcon kind={kind} />
            </span>
            <span className="mono">{EXTENSION_TEXT[kind]}</span>
            <span className="kindfilter__count mono">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
