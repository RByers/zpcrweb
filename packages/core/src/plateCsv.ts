/**
 * A plain-text, human-editable plate format — not part of the CFX file format, but a
 * zpcrweb-specific serialization of {@link PlateDefinition} so a plate can be authored, edited,
 * or attached to a run without needing a real (encrypted) `.pltd` file. Round-trips through
 * {@link plateToCsv} / {@link parsePlateCsv}. Canonical extension is `.plt.csv` (see
 * {@link isPlateCsvName}), to keep it distinguishable from the app's various other CSV
 * exports (decoded tables, plate-read dumps) inside a `.zpcr` archive or the file system.
 *
 * Layout: a handful of `# key: value` header comment lines (plate-level metadata), then a
 * standard CSV table with one row per well in row-major order. The fixed columns
 * (`Well`…`Quantity`) are followed by **one column per fluorophore**, labelled with the dye
 * name (see {@link FLUOR_COLUMN_RE}); each cell holds only that well's target for that fluor
 * (empty = the fluor isn't in the well, {@link PRESENT_NO_TARGET} = in the well but with no
 * target). Those columns *are* the plate's fluor list (`PlateDefinition.fluors`) — there's no
 * separate header line to keep in sync. A well with no fluor cell filled in is unloaded
 * (`loaded: false`), and a well left out of the table entirely is empty.
 *
 * `SampleType` holds a normalized {@link SampleType} name; a raw CFX `wellSampleType` code is
 * accepted there too and normalized on read (see {@link SAMPLE_TYPE_TO_RAW}).
 *
 * Only `plateName` is always written: `rows`/`columns` fall back to the extent implied by the
 * well labels, and `plateType`/`scanMode`/`standardUnits` are display-only passengers from a
 * `.pltd`, omitted when empty. The plate's `identityKey` isn't written at all — the file or
 * archive-entry name *is* the plate's identity, and {@link parsePlateCsv}'s `sourceName` puts
 * it back. Header values are read up to the first comma, so a file round-tripped through a
 * spreadsheet — which pads every comment line out to the table's column count with trailing
 * commas — still parses.
 */

import { toSampleType } from "./pltd.js";
import type { PlateDefinition, PlateFluor, SampleType, WellDefinition, WellFluor } from "./pltd.js";

/**
 * Normalized type → the `wellSampleType` code a `.pltd` would carry. `other` is deliberately
 * absent: it isn't a code, it's "we didn't recognize the code", so a well of that type writes
 * its preserved {@link WellDefinition.sampleTypeRaw} into the SampleType cell instead (and
 * {@link parsePlateCsv} normalizes it back). Inventing a `wcOther` here, as an earlier version
 * did, both fabricated a code CFX never emits and lost the real one on every round-trip.
 */
const SAMPLE_TYPE_TO_RAW: Record<Exclude<SampleType, "other">, string> = {
  unknown: "wcSample",
  standard: "wcStandard",
  ntc: "wcNTC",
  nrt: "wcNRT",
  positiveControl: "wcPositiveControl",
  negativeControl: "wcNegativeControl",
  empty: "wcEmpty",
  passiveRef: "wcPassiveRef",
  custom: "wcCustom",
};
const SAMPLE_TYPES = [...Object.keys(SAMPLE_TYPE_TO_RAW), "other"] as SampleType[];

function indexToRowLetters(n: number): string {
  let s = "";
  let m = n + 1;
  while (m > 0) {
    const rem = (m - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    m = Math.floor((m - 1) / 26);
  }
  return s;
}

function rowLettersToIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------------------
// Minimal CSV read/write (RFC4180-ish: quoted fields, "" escaping, CRLF or LF rows).
// ---------------------------------------------------------------------------

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvRow(cells: string[]): string {
  return cells.map(csvField).join(",") + "\r\n";
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip; \n (or end of input) terminates the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------
// Fluor columns: one per plate fluor, cell = that well's target for the fluor. A well can carry
// a fluor with no target, which an empty cell can't express (empty means "fluor absent"), so
// that case is written as a lone marker.
// ---------------------------------------------------------------------------

/** Fluor cell contents meaning "this fluor is in the well, but has no target". */
const PRESENT_NO_TARGET = "+";

const FIXED_COLUMNS = ["Well", "SampleType", "Sample", "Replicate", "Quantity"];

/**
 * A fluor column is labelled with the dye name alone (`FAM`, `Tex 615`). The channel isn't
 * written, because a dye is only ever read on one channel and the run's own `.Dcal`
 * calibration says which (`Dcal.primaryChannel`) — see {@link ParsePlateCsvOptions.channelForFluor},
 * which `zpcr.plates()` wires up. An explicit ` Ch<n>` suffix (1-based, the "FAM Ch1" form the
 * app displays) is still honoured if a file carries one, and wins over the lookup; with
 * neither, a column falls back to its position among the fluor columns.
 */
const FLUOR_COLUMN_RE = /^(.*?)\s+Ch(\d+)$/;

/** A well carrying nothing at all — the row is left out of the table, since a well missing from
 * the table parses back to exactly this (the `# rows`/`# columns` header keeps the extent). On
 * a typical plate that's most of the file. Exported so displays of a plate's wells can hide the
 * same nothing-to-say wells this format omits. */
export function isBlankWell(w: WellDefinition): boolean {
  return (
    !w.loaded &&
    w.fluors.length === 0 &&
    w.sampleType === "empty" &&
    !w.sample &&
    w.replicate === undefined &&
    w.quantity === undefined
  );
}

/** Serialize a {@link PlateDefinition} to zpcrweb's plate CSV format. */
export function plateToCsv(plate: PlateDefinition): string {
  let out = "";
  out += `# zpcrweb plate definition\r\n`;
  // No `identityKey` line: the file/archive-entry name is the plate's identity, and
  // `parsePlateCsv`'s `sourceName` puts it back.
  out += `# plateName: ${plate.plateName}\r\n`;
  // Optional, and omitted when empty: nothing computes with these three, they're just carried
  // through from a `.pltd` for display.
  if (plate.plateType) out += `# plateType: ${plate.plateType}\r\n`;
  if (plate.scanMode) out += `# scanMode: ${plate.scanMode}\r\n`;
  if (plate.standardUnits) out += `# standardUnits: ${plate.standardUnits}\r\n`;
  out += `# rows: ${plate.rows}\r\n`;
  out += `# columns: ${plate.columns}\r\n`;
  out += csvRow([...FIXED_COLUMNS, ...plate.fluors.map((f) => f.fluor)]);
  for (const w of plate.wells) {
    if (isBlankWell(w)) continue;
    const byFluor = new Map(w.fluors.map((f) => [f.fluor, f]));
    out += csvRow([
      w.label,
      // `other` isn't a type name worth writing — write the code we couldn't recognize, so the
      // information survives the round-trip and a human can see what the plate actually said.
      w.sampleType === "other" ? w.sampleTypeRaw || "other" : w.sampleType,
      w.sample ?? "",
      w.replicate !== undefined ? String(w.replicate) : "",
      w.quantity !== undefined ? String(w.quantity) : "",
      ...plate.fluors.map((pf) => {
        const f = byFluor.get(pf.fluor);
        if (!f) return "";
        return f.target ? f.target : PRESENT_NO_TARGET;
      }),
    ]);
  }
  return out;
}

/** True for archive/file names this module writes and reads (`.plt.csv`); a bare `.csv` is
 * accepted leniently on upload elsewhere, but anything this app writes uses this extension. */
export function isPlateCsvName(name: string): boolean {
  return /\.plt\.csv$/i.test(name);
}

/** The plate's identity from the file/entry name it was read from: strip the `.plt.csv` (or
 * bare `.csv`) this module writes, and any directory part. `"S183-S185-RVP.plt.csv"` →
 * `"S183-S185-RVP.plt"`, which is exactly the `identityKey` a `.pltd`-sourced plate carries. */
function identityFromName(name: string): string | undefined {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/\.(plt\.)?csv$/i, "") || undefined;
}

export interface ParsePlateCsvOptions {
  /** The file or archive-entry name the text came from — the plate's `identityKey` (its
   * user-facing name), since the format doesn't duplicate it in a header line. Omit it and the
   * plate simply has no identity. */
  sourceName?: string;
  /** Which optical channel a dye is read on, normally from the run's `.Dcal` calibration
   * (`Dcal.primaryChannel` — `zpcr.plates()` supplies this). Called for every fluor column that
   * doesn't spell its channel out; returning `undefined` (an unknown dye) falls back to the
   * column's position. Channels are only ever used for coloring and grouping, never for the
   * color-separation solve itself, so a fallback is a display wart rather than a wrong number. */
  channelForFluor?: (fluor: string) => number | undefined;
}

/**
 * Parse zpcrweb's plate CSV format (see {@link plateToCsv}) back into a
 * {@link PlateDefinition}. See {@link ParsePlateCsvOptions} for the two things the text itself
 * doesn't carry — the plate's identity and its fluors' channels.
 */
export function parsePlateCsv(text: string, options: ParsePlateCsvOptions = {}): PlateDefinition {
  const { sourceName, channelForFluor } = options;
  const lines = text.split(/\r?\n/);
  const meta: Record<string, string> = {};
  let i = 0;
  while (i < lines.length && lines[i]!.trim().startsWith("#")) {
    // The value stops at the first comma: a spreadsheet round-trip pads every comment line out
    // to the table's column count with trailing commas, which would otherwise end up in the
    // value. Header values therefore can't contain a comma (the `fluors` list uses `;`).
    const m = /^#\s*([^:,]+):\s*([^,]*)/.exec(lines[i]!.trim());
    if (m) meta[m[1]!.trim()] = m[2]!.trim();
    i++;
  }

  const rows = parseCsvTable(lines.slice(i).join("\n")).filter(
    (r) => !(r.length === 1 && r[0] === ""),
  );
  if (rows.length === 0) throw new Error("Plate CSV: empty file (no header row)");
  const header = rows[0]!.map((c) => c.trim());
  const idx = Object.fromEntries(FIXED_COLUMNS.map((c) => [c, header.indexOf(c)]));
  for (const c of FIXED_COLUMNS) {
    if (idx[c] === -1) throw new Error(`Plate CSV: missing "${c}" column`);
  }

  const declaredRows = Number(meta.rows);
  const declaredCols = Number(meta.columns);
  const dataRows = rows.slice(1);
  // A table with no rows at all is only meaningful if the extent is declared — every well is
  // then simply empty (an all-empty plate writes no rows).
  if (dataRows.length === 0 && !(declaredRows > 0 && declaredCols > 0)) {
    throw new Error("Plate CSV: no well rows, and no rows/columns header to size the plate");
  }

  // Every column that isn't one of the fixed ones is a fluor column, and those columns are the
  // only declaration of the plate's fluors — see {@link FLUOR_COLUMN_RE}.
  const fluorColumns = header
    .map((name, column) => ({ name, column }))
    .filter(({ name }) => name !== "" && !FIXED_COLUMNS.includes(name))
    .map(({ name, column }, ordinal) => {
      const m = FLUOR_COLUMN_RE.exec(name);
      const fluor = m ? m[1]!.trim() : name;
      if (!fluor) throw new Error(`Plate CSV: malformed fluor column "${name}"`);
      const channel = m ? Number(m[2]) - 1 : channelForFluor?.(fluor) ?? ordinal;
      return { fluor, channel, column };
    });
  const fluors: PlateFluor[] = fluorColumns.map(({ fluor, channel }) => ({ fluor, channel }));

  // Row/column extent: prefer the declared header, else infer from the max well label seen.
  let maxRow = 0;
  let maxCol = 0;
  const parsedLabels = dataRows.map((r) => {
    const label = (r[idx.Well!] ?? "").trim();
    const m = /^([A-Za-z]+)(\d+)$/.exec(label);
    if (!m) throw new Error(`Plate CSV: malformed well label "${label}"`);
    const row = rowLettersToIndex(m[1]!);
    const col = Number(m[2]!) - 1;
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
    return { label, row, col };
  });
  const rowsCount = Number.isFinite(declaredRows) && declaredRows > 0 ? declaredRows : maxRow + 1;
  const columns = Number.isFinite(declaredCols) && declaredCols > 0 ? declaredCols : maxCol + 1;

  const wells: WellDefinition[] = Array.from({ length: rowsCount * columns }, (_, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    return {
      index,
      row,
      col,
      label: `${indexToRowLetters(row)}${col + 1}`,
      loaded: false,
      fluors: [],
      sampleType: "empty" as SampleType,
      sampleTypeRaw: SAMPLE_TYPE_TO_RAW.empty,
    };
  });

  const targets = new Set<string>();
  const samples = new Set<string>();
  dataRows.forEach((r, i) => {
    const { row, col } = parsedLabels[i]!;
    const wellIndex = row * columns + col;
    const w = wells[wellIndex];
    if (!w) throw new Error(`Plate CSV: well "${parsedLabels[i]!.label}" is outside the ${rowsCount}x${columns} plate`);

    // The cell holds a normalized type name; a blank cell means an empty well. Anything else is
    // taken to be a raw `wellSampleType` code — that's how `plateToCsv` writes an `other` well,
    // and it also lets a hand-authored file name a CFX code directly (`wcNTC` reads as `ntc`).
    const sampleTypeCell = (r[idx.SampleType!] ?? "").trim();
    const sampleType: SampleType = SAMPLE_TYPES.includes(sampleTypeCell as SampleType)
      ? (sampleTypeCell as SampleType)
      : sampleTypeCell === ""
        ? "empty"
        : toSampleType(sampleTypeCell);
    const wellFluors: WellFluor[] = [];
    for (const { fluor, channel, column } of fluorColumns) {
      const cell = (r[column] ?? "").trim();
      if (!cell) continue;
      wellFluors.push(cell === PRESENT_NO_TARGET ? { fluor, channel } : { fluor, channel, target: cell });
    }
    const sample = (r[idx.Sample!] ?? "").trim() || undefined;
    const replicateRaw = (r[idx.Replicate!] ?? "").trim();
    const replicate = replicateRaw === "" ? undefined : Number(replicateRaw);
    const quantityRaw = (r[idx.Quantity!] ?? "").trim();
    const quantity = quantityRaw === "" ? undefined : Number(quantityRaw);

    wells[wellIndex] = {
      index: wellIndex,
      row,
      col,
      label: parsedLabels[i]!.label,
      loaded: wellFluors.length > 0,
      fluors: wellFluors,
      sampleType,
      sampleTypeRaw: sampleType === "other" ? sampleTypeCell : SAMPLE_TYPE_TO_RAW[sampleType],
      sample,
      replicate,
      quantity,
    };
    for (const f of wellFluors) if (f.target) targets.add(f.target);
    if (sample) samples.add(sample);
  });

  return {
    plateName: meta.plateName ?? "",
    identityKey: sourceName ? identityFromName(sourceName) : undefined,
    rows: rowsCount,
    columns,
    dyeCount: fluors.length,
    scanMode: meta.scanMode ?? "",
    plateType: meta.plateType ?? "",
    standardUnits: meta.standardUnits ?? "",
    fluors,
    targets: [...targets],
    samples: [...samples],
    wells,
    meta: {},
  };
}
