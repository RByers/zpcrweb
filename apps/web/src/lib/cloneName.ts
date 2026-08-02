/**
 * Naming a copy of a loaded file — what the Overview toolbar's Clone button calls the new file.
 *
 * The rule is the one every desktop file manager uses: a trailing `(N)` before the extension,
 * counting up. A name that already carries one is *incremented* rather than nested, so cloning a
 * clone gives `run (3).zpcr`, not `run (2) (2).zpcr`.
 */

/**
 * The extensions the app loads (`core/fileKind.ts`), longest-first so a compound one wins over
 * its own tail — `plate.plt.csv` has to split as `plate` + `.plt.csv`, not `plate.plt` + `.csv`,
 * or the index lands in the middle of the extension.
 */
const EXTENSIONS = [".plt.csv", ".prcl.txt", ".zpcr", ".pcrd", ".pltd", ".prcl", ".json", ".csv", ".txt"];

/** Split `name` into its stem and one of the {@link EXTENSIONS}, or the whole name and `""` when
 * it ends in none of them. */
export function splitFileName(name: string): { base: string; ext: string } {
  for (const ext of EXTENSIONS) {
    if (name.length > ext.length && name.slice(-ext.length).toLowerCase() === ext) {
      return { base: name.slice(0, -ext.length), ext: name.slice(-ext.length) };
    }
  }
  return { base: name, ext: "" };
}

/**
 * The name for a copy of `name`: `run.zpcr` → `run (2).zpcr`, `run (2).zpcr` → `run (3).zpcr`.
 *
 * `taken` is consulted so a second clone of the same file doesn't collide with the first — the
 * store keys files by name+size and a same-named add *replaces* the file already there
 * (`ZpcrStore.addFiles`), which would silently eat the earlier clone rather than sitting beside
 * it. The counter keeps going up until it finds a free name.
 */
export function cloneFileName(name: string, taken: (candidate: string) => boolean): string {
  const { base, ext } = splitFileName(name);
  const numbered = /^(.*?)\s*\((\d+)\)$/.exec(base);
  const stem = numbered ? numbered[1]! : base;
  let n = numbered ? Number(numbered[2]) + 1 : 2;
  for (;;) {
    // A file that is nothing but an extension (`.zpcr`) has no stem to put a space after.
    const candidate = `${stem ? `${stem} ` : ""}(${n})${ext}`;
    if (!taken(candidate)) return candidate;
    n++;
  }
}
