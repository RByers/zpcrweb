/**
 * A plain-text, human-editable plate format — not part of the CFX file format, but a
 * zpcrweb-specific serialization of {@link PlateDefinition} so a plate can be authored, edited,
 * or attached to a run without needing a real (encrypted) `.pltd` file. Round-trips through
 * {@link plateToCsv} / {@link parsePlateCsv}. Canonical extension is `.plt.csv` (see
 * {@link isPlateCsvName}), to keep it distinguishable from the app's various other CSV
 * exports (decoded tables, plate-read dumps) inside a `.zpcr` archive or the file system.
 *
 * Layout: a handful of `# key: value` header comment lines (plate-level metadata), then a
 * standard CSV table with one row per well in row-major order. A well with an empty `Fluors`
 * cell is unloaded (`loaded: false`); the header's `fluors` line is the authoritative
 * fluor→channel mapping (`PlateDefinition.fluors`), since a well can omit its fluors even
 * when loaded is inferred from the presence of any.
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
// Fluors cell: "FAM=TargetA;HEX=TargetB" (bare "FAM" when no target). "=" and ";" inside a
// fluor/target name are percent-escaped so they can't be confused with the delimiters.
// ---------------------------------------------------------------------------

function escapeFluorPart(s: string): string {
  return s.replace(/%/g, "%25").replace(/=/g, "%3D").replace(/;/g, "%3B");
}

function unescapeFluorPart(s: string): string {
  return s.replace(/%3B/gi, ";").replace(/%3D/gi, "=").replace(/%25/g, "%");
}

function fluorsToCell(fluors: WellFluor[]): string {
  return fluors
    .map((f) =>
      f.target
        ? `${escapeFluorPart(f.fluor)}=${escapeFluorPart(f.target)}`
        : escapeFluorPart(f.fluor),
    )
    .join(";");
}

function cellToFluors(cell: string, channelByFluor: Map<string, number>): WellFluor[] {
  const trimmed = cell.trim();
  if (!trimmed) return [];
  return trimmed.split(";").map((part) => {
    const eq = part.indexOf("=");
    const fluorRaw = eq === -1 ? part : part.slice(0, eq);
    const targetRaw = eq === -1 ? "" : part.slice(eq + 1);
    const fluor = unescapeFluorPart(fluorRaw.trim());
    const channel = channelByFluor.get(fluor);
    if (channel === undefined) {
      throw new Error(`Plate CSV: well references unknown fluor "${fluor}" (not in the "fluors" header)`);
    }
    const target = unescapeFluorPart(targetRaw.trim());
    return target ? { fluor, channel, target } : { fluor, channel };
  });
}

const HEADER_COLUMNS = [
  "Well",
  "SampleType",
  "SampleName",
  "Condition",
  "Condition2",
  "Replicate",
  "Quantity",
  "Fluors",
];

/** Serialize a {@link PlateDefinition} to zpcrweb's plate CSV format. */
export function plateToCsv(plate: PlateDefinition): string {
  const fluorsHeader = plate.fluors.map((f) => `${escapeFluorPart(f.fluor)}:${f.channel}`).join(",");
  let out = "";
  out += `# zpcrweb plate definition\r\n`;
  out += `# plateName: ${plate.plateName}\r\n`;
  out += `# plateType: ${plate.plateType}\r\n`;
  out += `# scanMode: ${plate.scanMode}\r\n`;
  out += `# standardUnits: ${plate.standardUnits}\r\n`;
  out += `# rows: ${plate.rows}\r\n`;
  out += `# columns: ${plate.columns}\r\n`;
  out += `# fluors: ${fluorsHeader}\r\n`;
  out += csvRow(HEADER_COLUMNS);
  for (const w of plate.wells) {
    out += csvRow([
      w.label,
      w.sampleType,
      w.sampleName ?? "",
      w.condition ?? "",
      w.condition2 ?? "",
      w.replicate !== undefined ? String(w.replicate) : "",
      w.quantity !== undefined ? String(w.quantity) : "",
      fluorsToCell(w.fluors),
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
    const m = /^#\s*([^:]+):\s*(.*)$/.exec(lines[i]!.trim());
    if (m) meta[m[1]!.trim()] = m[2]!.trim();
    i++;
  }

  const rows = parseCsvTable(lines.slice(i).join("\n")).filter(
    (r) => !(r.length === 1 && r[0] === ""),
  );
  if (rows.length === 0) throw new Error("Plate CSV: empty file (no header row)");
  const header = rows[0]!;
  const idx = Object.fromEntries(HEADER_COLUMNS.map((c) => [c, header.indexOf(c)]));
  for (const c of HEADER_COLUMNS) {
    if (idx[c] === -1) throw new Error(`Plate CSV: missing "${c}" column`);
  }

  const declaredRows = Number(meta.rows);
  const declaredCols = Number(meta.columns);
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) throw new Error("Plate CSV: no well rows");

  const fluors: PlateFluor[] = (meta.fluors ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [nameRaw, chRaw] = entry.split(":");
      const fluor = unescapeFluorPart((nameRaw ?? "").trim());
      const channel = Number((chRaw ?? "").trim());
      if (!fluor || !Number.isFinite(channel)) {
        throw new Error(`Plate CSV: malformed "fluors" header entry "${entry}"`);
      }
      return { fluor, channel };
    });
  const channelByFluor = new Map(fluors.map((f) => [f.fluor, f.channel]));

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
  const conditions = new Set<string>();
  dataRows.forEach((r, i) => {
    const { row, col } = parsedLabels[i]!;
    const wellIndex = row * columns + col;
    const w = wells[wellIndex];
    if (!w) throw new Error(`Plate CSV: well "${parsedLabels[i]!.label}" is outside the ${rowsCount}x${columns} plate`);

    const sampleTypeCell = (r[idx.SampleType!] ?? "").trim();
    const sampleType: SampleType = SAMPLE_TYPES.includes(sampleTypeCell as SampleType)
      ? (sampleTypeCell as SampleType)
      : "empty";
    const fluorCell = r[idx.Fluors!] ?? "";
    const wellFluors = cellToFluors(fluorCell, channelByFluor);
    const sampleName = (r[idx.SampleName!] ?? "").trim() || undefined;
    const condition = (r[idx.Condition!] ?? "").trim() || undefined;
    const condition2 = (r[idx.Condition2!] ?? "").trim() || undefined;
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
      sampleName,
      condition,
      condition2,
      replicate,
      quantity,
    };
    for (const f of wellFluors) if (f.target) targets.add(f.target);
    if (condition) conditions.add(condition);
    if (condition2) conditions.add(condition2);
  });

  return {
    plateName: meta.plateName ?? "",
    rows: rowsCount,
    columns,
    dyeCount: fluors.length,
    scanMode: meta.scanMode ?? "",
    plateType: meta.plateType ?? "",
    standardUnits: meta.standardUnits ?? "",
    fluors,
    targets: [...targets],
    conditions: [...conditions],
    wells,
    meta: {},
  };
}
