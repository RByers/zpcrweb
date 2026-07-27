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
 * (`Well`…`Quantity`) are followed by **one column per fluorophore**, labelled with the fluor
 * name; each cell holds only that well's target for that fluor (empty = the fluor isn't in the
 * well, {@link PRESENT_NO_TARGET} = in the well but with no target). A well with no fluor cell
 * filled in is unloaded (`loaded: false`). The header's `fluors` line stays the authoritative
 * fluor→channel mapping (`PlateDefinition.fluors`) and fixes the column order; it is
 * `;`-separated so no header line ever contains a comma.
 *
 * Header values are read up to the first comma, so a file round-tripped through a spreadsheet
 * — which pads every comment line out to the table's column count with trailing commas — still
 * parses.
 */

import type { PlateDefinition, PlateFluor, SampleType, WellDefinition, WellFluor } from "./pltd.js";

const SAMPLE_TYPE_TO_RAW: Record<SampleType, string> = {
  unknown: "wcSample",
  standard: "wcStandard",
  ntc: "wcNTC",
  nrt: "wcNRT",
  positiveControl: "wcPositiveControl",
  negativeControl: "wcNegativeControl",
  empty: "wcEmpty",
  passiveRef: "wcPassiveRef",
  custom: "wcCustom",
  other: "wcOther",
};
const SAMPLE_TYPES = Object.keys(SAMPLE_TYPE_TO_RAW) as SampleType[];

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

/** The `# fluors:` header line is `;`-separated (a comma would end the header value) and uses
 * `:` before the channel, so both are percent-escaped inside a fluor name. */
function escapeFluorName(s: string): string {
  return s.replace(/%/g, "%25").replace(/:/g, "%3A").replace(/;/g, "%3B");
}

function unescapeFluorName(s: string): string {
  return s.replace(/%3B/gi, ";").replace(/%3A/gi, ":").replace(/%25/g, "%");
}

const FIXED_COLUMNS = ["Well", "SampleType", "Sample", "Replicate", "Quantity"];

/** Serialize a {@link PlateDefinition} to zpcrweb's plate CSV format. */
export function plateToCsv(plate: PlateDefinition): string {
  const fluorsHeader = plate.fluors.map((f) => `${escapeFluorName(f.fluor)}:${f.channel}`).join(";");
  let out = "";
  out += `# zpcrweb plate definition\r\n`;
  if (plate.identityKey) out += `# identityKey: ${plate.identityKey}\r\n`;
  out += `# plateName: ${plate.plateName}\r\n`;
  out += `# plateType: ${plate.plateType}\r\n`;
  out += `# scanMode: ${plate.scanMode}\r\n`;
  out += `# standardUnits: ${plate.standardUnits}\r\n`;
  out += `# rows: ${plate.rows}\r\n`;
  out += `# columns: ${plate.columns}\r\n`;
  out += `# fluors: ${fluorsHeader}\r\n`;
  out += csvRow([...FIXED_COLUMNS, ...plate.fluors.map((f) => f.fluor)]);
  for (const w of plate.wells) {
    const byFluor = new Map(w.fluors.map((f) => [f.fluor, f]));
    out += csvRow([
      w.label,
      w.sampleType,
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

/** Parse zpcrweb's plate CSV format (see {@link plateToCsv}) back into a {@link PlateDefinition}. */
export function parsePlateCsv(text: string): PlateDefinition {
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
  if (dataRows.length === 0) throw new Error("Plate CSV: no well rows");

  const fluors: PlateFluor[] = (meta.fluors ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [nameRaw, chRaw] = entry.split(":");
      const fluor = unescapeFluorName((nameRaw ?? "").trim());
      const channel = Number((chRaw ?? "").trim());
      if (!fluor || !Number.isFinite(channel)) {
        throw new Error(`Plate CSV: malformed "fluors" header entry "${entry}"`);
      }
      return { fluor, channel };
    });
  const channelByFluor = new Map(fluors.map((f) => [f.fluor, f.channel]));

  // Every column that isn't one of the fixed ones is a fluor column, named for its fluor.
  const fluorColumns = header
    .map((name, column) => ({ name, column }))
    .filter(({ name }) => name !== "" && !FIXED_COLUMNS.includes(name))
    .map(({ name, column }) => {
      const channel = channelByFluor.get(name);
      if (channel === undefined) {
        throw new Error(`Plate CSV: column "${name}" is an unknown fluor (not in the "fluors" header)`);
      }
      return { fluor: name, channel, column };
    });

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

    const sampleTypeCell = (r[idx.SampleType!] ?? "").trim();
    const sampleType: SampleType = SAMPLE_TYPES.includes(sampleTypeCell as SampleType)
      ? (sampleTypeCell as SampleType)
      : "empty";
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
      sampleTypeRaw: SAMPLE_TYPE_TO_RAW[sampleType] ?? sampleTypeCell,
      sample,
      replicate,
      quantity,
    };
    for (const f of wellFluors) if (f.target) targets.add(f.target);
    if (sample) samples.add(sample);
  });

  return {
    plateName: meta.plateName ?? "",
    identityKey: meta.identityKey || undefined,
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
