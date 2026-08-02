/**
 * What a file *is*, as opposed to how it is encoded.
 *
 * This library reads six file formats, but they are only three kinds of thing: a whole **run**, a
 * **plate** map, or a thermal **protocol**. Each of those has more than one encoding — a run
 * arrives as a `.zpcr`, a `.pcrd` or a Biomeme `.json`; a plate as an encrypted `.pltd` or a
 * `.plt.csv`; a protocol as a `.prcl` or this project's `.prcl.txt` — and which encoding it came
 * in is, for most purposes, an implementation detail of the parse. A consumer asking "can this be
 * the plate half of a run?" or "which icon does this get?" is asking about the category, so the
 * mapping belongs here rather than being re-derived from an extension at each call site.
 *
 * The format docs, one per encoding: `zpcr` → `ARCHITECTURE.md`, `pcrd` → `pcrd.md`, `biomeme` →
 * `biomeme.md`, `pltd` → `pltd.md`, `csv` → `plateCsv.ts`, `prcl` → `prcl.md` (§3.1 for the text
 * form).
 */

/** One accepted encoding. `csv` is a `.plt.csv` plate table; `prcl` covers both `.prcl` and the
 * `.prcl.txt` text form. */
export type FileKind = "zpcr" | "pcrd" | "biomeme" | "pltd" | "csv" | "prcl";

/** What the file describes, independent of encoding. A run carries both other halves. */
export type FileCategory = "run" | "plate" | "protocol";

const CATEGORY: Record<FileKind, FileCategory> = {
  zpcr: "run",
  pcrd: "run",
  biomeme: "run",
  pltd: "plate",
  csv: "plate",
  prcl: "protocol",
};

/** The category a kind belongs to — the one place the encoding→thing mapping is written down. */
export function fileCategory(kind: FileKind): FileCategory {
  return CATEGORY[kind];
}

const CATEGORY_LABEL: Record<FileCategory, string> = {
  run: "Run",
  plate: "Plate",
  protocol: "Protocol",
};

/** What each encoding actually is, in a few words — the second half of {@link fileKindDescription},
 * kept separate from the category label so that label can be reused on its own (chip/table
 * tooltips) without repeating the sentence. */
const DESCRIPTION: Record<FileKind, string> = {
  zpcr: "Bio-Rad CFX instrument raw output",
  pcrd: "Bio-Rad CFX Manager saved experiment",
  biomeme: "biomeme json results",
  pltd: "Bio-Rad format",
  csv: "zpcrweb comma-separated values",
  prcl: "Bio-Rad CFX thermal-cycling protocol",
};

/** A one-line, human-facing description of a file's format — `"<Category>: <what it is>"`, e.g.
 * `"Plate: Bio-Rad format"` for a `.pltd` or `"Plate: zpcrweb comma-separated values"` for its
 * `.plt.csv` counterpart. The UI shows this verbatim (hover cards, the file overview's first
 * row) rather than re-deriving wording per kind, so a new encoding only needs an entry here. */
export function fileKindDescription(kind: FileKind): string {
  return `${CATEGORY_LABEL[CATEGORY[kind]]}: ${DESCRIPTION[kind]}`;
}
