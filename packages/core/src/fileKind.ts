/**
 * What a file *is*, as opposed to how it is encoded.
 *
 * This library reads seven file formats, but they are only four kinds of thing: a whole **run**, a
 * **plate** map, a thermal **protocol**, or a **report** of a run that happened. Each of those has
 * more than one encoding — a run arrives as a `.zpcr`, a `.pcrd` or a Biomeme `.bmrun`; a plate as
 * an encrypted `.pltd` or a `.plt.csv`; a protocol as a `.prcl` or this project's `.prcl.txt` —
 * and which encoding it came in is, for most purposes, an implementation detail of the parse. A
 * consumer asking "can this be the plate half of a run?" or "which icon does this get?" is asking
 * about the category, so the mapping belongs here rather than being re-derived from an extension
 * at each call site.
 *
 * A **report** is the odd one out, and deliberately not a run: an `.alf` says a protocol executed,
 * when, for how long and whether it completed, and carries no fluorescence at all. It is what a
 * thermal-only run leaves behind — the instrument writes one to `\Storage Card\PCRunReport` for
 * every run, and for a protocol with no `PLATEREAD` it is the *only* thing that run produces (see
 * `usb.md` §7.10). Categorising it as a run would offer it everywhere a run belongs, and every one
 * of those places would then find it empty.
 *
 * The format docs, one per encoding: `zpcr` → `ARCHITECTURE.md`, `pcrd` → `pcrd.md`, `biomeme` →
 * `biomeme.md`, `pltd` → `pltd.md`, `csv` → `plateCsv.ts`, `prcl` → `prcl.md` (§3.1 for the text
 * form), `alf` → `alf.md`.
 *
 * {@link SUPPORTED_EXTENSIONS} is the other half of the same idea: the file *names* worth offering
 * to a decoder, kept here so a directory listing, a file picker and the loader all agree on what
 * counts as openable.
 */

/** One accepted encoding. `csv` is a `.plt.csv` plate table; `prcl` covers both `.prcl` and the
 * `.prcl.txt` text form; `alf` is an instrument run report. */
export type FileKind = "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv" | "prcl" | "alf";

/** What the file describes, independent of encoding. A run carries the plate and protocol halves;
 * a report carries none of them. */
export type FileCategory = "run" | "plate" | "protocol" | "report";

const CATEGORY: Record<FileKind, FileCategory> = {
  zpcr: "run",
  pcrd: "run",
  biomeme: "run",
  pltd: "plate",
  csv: "plate",
  prcl: "protocol",
  alf: "report",
};

/** The category a kind belongs to — the one place the encoding→thing mapping is written down. */
export function fileCategory(kind: FileKind): FileCategory {
  return CATEGORY[kind];
}

const CATEGORY_LABEL: Record<FileCategory, string> = {
  run: "Run",
  plate: "Plate",
  protocol: "Protocol",
  report: "Report",
};

/** What each encoding actually is, in a few words — the second half of {@link fileKindDescription},
 * kept separate from the category label so that label can be reused on its own (chip/table
 * tooltips) without repeating the sentence. */
const DESCRIPTION: Record<FileKind, string> = {
  zpcr: "Bio-Rad CFX instrument raw output",
  pcrd: "Bio-Rad CFX Manager saved experiment",
  biomeme: "Biomeme handheld device results",
  pltd: "Bio-Rad format",
  csv: "zpcrweb comma-separated values",
  prcl: "Bio-Rad CFX thermal-cycling protocol",
  alf: "Bio-Rad CFX run report",
};

/** A one-line, human-facing description of a file's format — `"<Category>: <what it is>"`, e.g.
 * `"Plate: Bio-Rad format"` for a `.pltd` or `"Plate: zpcrweb comma-separated values"` for its
 * `.plt.csv` counterpart. The UI shows this verbatim (hover cards, the file overview's first
 * row) rather than re-deriving wording per kind, so a new encoding only needs an entry here. */
export function fileKindDescription(kind: FileKind): string {
  return `${CATEGORY_LABEL[CATEGORY[kind]]}: ${DESCRIPTION[kind]}`;
}

/**
 * Every extension worth handing to a decoder — what a file picker offers, what a directory listing
 * shows, and what the loader will attempt.
 *
 * This is a *name* filter and nothing more: passing it does not mean a file will open. `.txt` is
 * here because `.prcl.txt` is, and a `.txt` is admitted only if its bytes really are a run
 * definition (`prcl.md` §3.1) — the loader's own sniff decides that, not this list. `.prcl` itself
 * is absent because no reader for the binary form is wired up yet.
 *
 * Kept beside {@link FileKind} so the three places that need it — the picker's `accept`, the
 * loader's prefilter, and the disk-folder directory lister — cannot drift apart, which they had by
 * the time there were three of them.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  ".zpcr",
  ".pcrd",
  ".bmrun",
  ".pltd",
  ".csv",
  ".txt",
  ".alf",
];

/** Whether a file name ends in one of {@link SUPPORTED_EXTENSIONS}, case-insensitively. */
export function matchesSupportedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Extension → the kind that extension is *decoded as*, longest first so `.plt.csv` is read as the
 * plate table it is before the bare `.csv` rule can claim it. */
const KIND_BY_EXTENSION: readonly (readonly [string, FileKind])[] = [
  [".zpcr", "zpcr"],
  [".pcrd", "pcrd"],
  [".bmrun", "biomeme"],
  [".pltd", "pltd"],
  [".csv", "csv"],
  [".txt", "prcl"],
  [".alf", "alf"],
];

/**
 * What a file of this *name* would be decoded as, or null if the name isn't one worth trying.
 *
 * **A guess from the name alone, and the only one available before the bytes are read.** The
 * authority is still the loader's own content sniff — a `.txt` is admitted only once it parses as a
 * run definition (`prcl.md` §3.1), and a `.csv` only as a plate table — so this answers "what would
 * this be?", which is exactly the question a directory listing can ask about a file nobody has
 * opened. A file already open has a real, decoded {@link FileKind}; use that in preference.
 */
export function fileKindFromName(name: string): FileKind | null {
  const lower = name.toLowerCase();
  return KIND_BY_EXTENSION.find(([ext]) => lower.endsWith(ext))?.[1] ?? null;
}
