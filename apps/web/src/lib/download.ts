import { wellLabel, type PlateRead, type Zpcr } from "@zpcrweb/core";
import { channelLabel } from "./channelColors";

/**
 * Client-side "Save As" for the Raw files view: text/XML entries download verbatim, decoded
 * table entries are flattened to CSV from the rendered DOM (see {@link decodedToCsv}) so the
 * export always matches whatever the table/segmented-control state currently shows on screen.
 * The one exception is a decoded `.Plateread` (see {@link plateReadToCsv}): its on-screen table
 * only ever shows one channel/stat slice at a time, so the CSV is built straight from the
 * decoded data instead, to include every well and channel.
 */

/** Trigger a browser download of `content` as `filename`. */
export function downloadText(filename: string, content: string, mimeType = "text/plain"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvRow(cells: string[]): string {
  return cells.map(csvField).join(",") + "\r\n";
}

function dlToRows(dl: Element): string[][] {
  const pairs = dl.querySelectorAll(".decoded__pair");
  if (pairs.length > 0) {
    return Array.from(pairs, (p) => [
      p.querySelector("dt")?.textContent?.trim() ?? "",
      p.querySelector("dd")?.textContent?.trim() ?? "",
    ]);
  }
  // Plain <dl><dt/><dd/>...</dl> with no .decoded__pair wrapper: pair up children in order.
  const children = Array.from(dl.children);
  const rows: string[][] = [];
  for (let i = 0; i < children.length; i += 2) {
    rows.push([children[i]?.textContent?.trim() ?? "", children[i + 1]?.textContent?.trim() ?? ""]);
  }
  return rows;
}

function tableToRows(table: Element): string[][] {
  return Array.from(table.querySelectorAll("tr"), (tr) =>
    Array.from(tr.querySelectorAll("th,td"), (cell) => (cell.textContent ?? "").trim()),
  );
}

/**
 * Flatten a decoded view's rendered DOM to CSV: every `<h3>` becomes a one-cell section title,
 * every `<dl>` (key/value pairs) and `<table>` becomes its own block of rows, in document
 * order. Reading straight from the DOM — rather than re-deriving from the underlying decoded
 * data per file type — means the export always matches what's on screen (e.g. RunLogTable's
 * column/severity filters, or a wide table's currently-selected channel/stat).
 * Falls back to one row per line of visible text for decoded views with no table/dl (e.g. the
 * plaintext protocol step list).
 */
export function decodedToCsv(container: Element): string {
  const blocks = Array.from(container.querySelectorAll("h3, table, dl"));
  if (blocks.length === 0) {
    const text = (container as HTMLElement).innerText ?? container.textContent ?? "";
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => csvRow([line]))
      .join("");
  }
  let out = "";
  for (const el of blocks) {
    if (el.tagName === "H3") {
      if (out !== "") out += "\r\n";
      out += csvRow([el.textContent?.trim() ?? ""]);
    } else if (el.tagName === "DL") {
      for (const row of dlToRows(el)) out += csvRow(row);
    } else {
      for (const row of tableToRows(el)) out += csvRow(row);
    }
  }
  return out;
}

const PLATE_ROWS = 9; // A-H plus the reference row (see `wellLabel`/`REFERENCE_ROW` in @zpcrweb/core)
const PLATE_COLS = 12;

/**
 * Every WELLDATA + DARKDATA reading in a `.Plateread`, as one flat table: one row per
 * (well, channel) plus one row per channel's dark (LED-off background) reading. Dark readings
 * have no well position, so they use the well value `"dark"` instead — still keeping their real
 * channel, since DARKDATA is itself recorded per channel.
 */
export function plateReadToCsv(read: PlateRead): string {
  const channelCount = read.dark.length;
  let out = csvRow(["well", "channel", "mean", "min", "max", "stddev"]);
  for (let row = 0; row < PLATE_ROWS; row++) {
    for (let col = 0; col < PLATE_COLS; col++) {
      const well = wellLabel(row, col);
      for (let ch = 0; ch < channelCount; ch++) {
        const r = read.get(ch, row, col);
        out += csvRow([well, channelLabel(ch), String(r.mean), String(r.min), String(r.max), String(r.std)]);
      }
    }
  }
  for (let ch = 0; ch < channelCount; ch++) {
    const d = read.dark[ch]!;
    out += csvRow(["dark", channelLabel(ch), String(d.mean), String(d.min), String(d.max), String(d.std)]);
  }
  return out;
}

function sanitizeFilePart(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim();
}

/** `<run name>_cycle<N>.csv` — the run name is the instrument-recorded data file name
 * (`RunInfo.xml`'s `DataFile` key, `zpcr.metadata.dataFile`), since a `Zpcr` carries no other
 * run-identifying field (see `packages/core/src/types.ts`'s `RunMetadata`). */
export function plateReadCsvFilename(zpcr: Zpcr, read: PlateRead): string {
  const runName = sanitizeFilePart(zpcr.metadata.dataFile.replace(/\.(zpcr|pcrd)$/i, "")) || "run";
  return `${runName}_cycle${read.cycle}.csv`;
}
