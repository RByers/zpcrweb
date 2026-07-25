/**
 * Client-side "Save As" for the Raw files view: text/XML entries download verbatim, decoded
 * table entries are flattened to CSV from the rendered DOM (see {@link decodedToCsv}) so the
 * export always matches whatever the table/segmented-control state currently shows on screen.
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
