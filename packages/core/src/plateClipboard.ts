/**
 * Copying and pasting a **block of wells** — the clipboard half of the plate editor, and the
 * bridge between it and a spreadsheet.
 *
 * The exchange format is tab-separated text, because that is what a spreadsheet puts on the
 * system clipboard and reads back off it: copy a column of sample names in Excel or Sheets, paste
 * it onto a column of wells, and it lands. A block copied out of the editor is the same text, with
 * a header row naming its columns so a round-trip through the app is exact.
 *
 * The columns are the same fields, spelled the same way, as `.plt.csv`'s (`pltcsv.md` §3) — the
 * optional ones (`Vessel`, `Replicate`, `Quantity`) written only when some copied well carries
 * one, and a fluor column per dye holding that well's target, `+` for "in the well with no
 * target" (§4). A blank cell **clears** the field, which is what makes copying an empty well over
 * a loaded one empty it.
 *
 * On paste, a first row naming known columns is a header and decides the mapping. Without one the
 * columns are read positionally as `Sample`, `SampleType`, then the plate's dyes in order — so
 * the commonest paste of all, a bare column of names out of a spreadsheet, sets the samples.
 *
 * Geometry is the caller's: {@link parsePlateBlock} returns a grid of patches, and the editor
 * decides which wells they land on (anchored at the selection's top-left, or applied to the whole
 * selection when the block is a single cell).
 */

import { byChannel } from "./pltd.js";
import { toSampleType, SAMPLE_TYPES } from "./pltd.js";
import type { PlateDefinition, SampleType, WellDefinition } from "./pltd.js";
import type { WellPatch } from "./plateEdit.js";

/** Fluor cell meaning "this dye is in the well, but has no target" — `.plt.csv`'s own marker
 * (`pltcsv.md` §4), so a cell copied from one file reads the same in the other. */
const PRESENT_NO_TARGET = "+";

/** The non-fluor columns, in the order they are written. `Sample` leads: it is the field a
 * headerless paste is most likely to be. */
const FIXED_COLUMNS = ["Sample", "SampleType", "Vessel", "Replicate", "Quantity"] as const;
type FixedColumn = (typeof FIXED_COLUMNS)[number];

/** A rectangular block of wells, as the clipboard carries it. */
export interface PlateBlock {
  /** Row-major grid of patches; `rows[r][c]` is one well. */
  rows: WellPatch[][];
  columns: number;
}

/**
 * Serialize the selected wells as a tab-separated block: the bounding rectangle of the selection,
 * with wells inside it that aren't selected written as blank rows of cells (a spreadsheet's own
 * behaviour for a non-rectangular selection).
 */
export function formatPlateBlock(
  plate: PlateDefinition,
  indices: Iterable<number>,
): string {
  const chosen = new Set(indices);
  const wells = plate.wells.filter((w) => chosen.has(w.index));
  if (wells.length === 0) return "";
  const top = Math.min(...wells.map((w) => w.row));
  const left = Math.min(...wells.map((w) => w.col));
  const bottom = Math.max(...wells.map((w) => w.row));
  const right = Math.max(...wells.map((w) => w.col));

  // Same rule the CSV uses for these three: a column of empty cells says nothing, so it is only
  // written when some copied well fills it in.
  const optional = new Set<FixedColumn>();
  for (const w of wells) {
    if (w.vessel) optional.add("Vessel");
    if (w.replicate !== undefined) optional.add("Replicate");
    if (w.quantity !== undefined) optional.add("Quantity");
  }
  const fixed: FixedColumn[] = FIXED_COLUMNS.filter(
    (c) => c === "Sample" || c === "SampleType" || optional.has(c),
  );
  const fluors = [...plate.fluors].sort(byChannel).map((f) => f.fluor);

  const lines = [[...fixed, ...fluors].join("\t")];
  for (let row = top; row <= bottom; row++) {
    const cells: string[] = [];
    for (let col = left; col <= right; col++) {
      const w = plate.wells[row * plate.columns + col];
      const include = w && chosen.has(w.index);
      cells.push(
        [
          ...fixed.map((c) => (include ? fixedCell(w, c) : "")),
          ...fluors.map((fluor) => (include ? fluorCell(w, fluor) : "")),
        ].join("\t"),
      );
    }
    lines.push(cells.join("\t"));
  }
  // A block is a grid of *wells*, each of which is several tab-separated fields; the row line
  // above concatenates them, so a reader has to know the field count. That is what the header
  // row states, and {@link parsePlateBlock} recovers the well width from it.
  return lines.join("\n") + "\n";
}

function fixedCell(w: WellDefinition, column: FixedColumn): string {
  switch (column) {
    case "Sample":
      return w.sample ?? "";
    case "SampleType":
      // An `other` well writes the raw code it preserved, exactly as the CSV does — it is the
      // only record of what the source file said.
      return w.sampleType === "other" ? w.sampleTypeRaw || "other" : w.sampleType;
    case "Vessel":
      return w.vessel ?? "";
    case "Replicate":
      return w.replicate !== undefined ? String(w.replicate) : "";
    case "Quantity":
      return w.quantity !== undefined ? String(w.quantity) : "";
  }
}

function fluorCell(w: WellDefinition, fluor: string): string {
  const f = w.fluors.find((wf) => wf.fluor === fluor);
  if (!f) return "";
  return f.target ? f.target : PRESENT_NO_TARGET;
}

/**
 * Read a tab-separated block back into a grid of {@link WellPatch}es — see the module comment for
 * how a header row (or its absence) decides which column is which. Returns `null` for text that
 * holds no cells at all.
 *
 * `plate` supplies the dye names a headerless block's columns are read as; a header naming a dye
 * the plate doesn't have is fine, and {@link applyWellPatches} adds it.
 */
export function parsePlateBlock(text: string, plate: PlateDefinition): PlateBlock | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return null;

  const first = lines[0]!.split("\t").map((c) => c.trim());
  const plateFluors = [...plate.fluors].sort(byChannel).map((f) => f.fluor);
  const known = new Set<string>([...FIXED_COLUMNS, ...plateFluors]);
  // A header row is one whose cells are all non-empty and distinct, at least one of them naming a
  // column this plate knows. The "at least one known" is what tells a header from data; not
  // requiring *all* of them is what lets a header introduce a dye the plate doesn't have yet
  // (`Sample⇥Cy5`), which is how a paste brings a new channel with it.
  const hasHeader =
    first.length > 0 &&
    first.every((c) => c !== "") &&
    new Set(first).size === first.length &&
    first.some((c) => known.has(c));
  const columns = hasHeader ? first : [...FIXED_COLUMNS.slice(0, 2), ...plateFluors];
  const dataLines = hasHeader ? lines.slice(1) : lines;
  if (dataLines.length === 0) return null;

  const width = columns.length;
  const rows: WellPatch[][] = dataLines.map((line) => {
    const cells = line.split("\t");
    // A row holds a whole number of wells; a short trailing well is padded with blanks rather
    // than dropped, so a hand-typed block still lands.
    const count = Math.max(1, Math.ceil(cells.length / width));
    return Array.from({ length: count }, (_, i) =>
      patchFromCells(columns, cells.slice(i * width, (i + 1) * width)),
    );
  });
  return { rows, columns: Math.max(...rows.map((r) => r.length)) };
}

function patchFromCells(columns: string[], cells: string[]): WellPatch {
  const patch: WellPatch = { fluors: {} };
  columns.forEach((column, i) => {
    // A cell that isn't there at all is not a blank cell: a short row — one column of sample
    // names pasted from a spreadsheet — says nothing about the columns it doesn't reach, and
    // must leave them alone. Only a cell that exists and is empty clears its field.
    if (i >= cells.length) return;
    const cell = cells[i]!.trim();
    switch (column) {
      case "Sample":
        patch.sample = cell || null;
        return;
      case "SampleType":
        patch.sampleType = cell ? readSampleType(cell) : "empty";
        return;
      case "Vessel":
        patch.vessel = cell || null;
        return;
      case "Replicate":
        patch.replicate = numberOrNull(cell);
        return;
      case "Quantity":
        patch.quantity = numberOrNull(cell);
        return;
      default:
        // Everything else is a dye column. Blank takes the dye out of the well; the marker puts
        // it in with no target.
        patch.fluors![column] = cell === "" ? null : cell === PRESENT_NO_TARGET ? "" : cell;
    }
  });
  return patch;
}

/** A normalized type name, or a raw `wc*` code — the same two spellings `.plt.csv` accepts, so a
 * cell copied out of either file reads back. */
function readSampleType(cell: string): SampleType {
  return SAMPLE_TYPES.includes(cell as SampleType) ? (cell as SampleType) : toSampleType(cell);
}

function numberOrNull(cell: string): number | null {
  if (cell === "") return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
}
