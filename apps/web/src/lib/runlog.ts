/**
 * Parse a CFX `runlog.xml` into structured log entries. The file is not single-rooted (a
 * BOM, an empty header element, then many sibling `<Log>` records with no wrapper), so we
 * strip the BOM/declaration and wrap the body in a synthetic root for DOMParser, then read
 * the `<Log>` children. Presentation-side parsing (a log viewer), kept in the app.
 */

export interface RunLogEntry {
  /** Field name → text value, e.g. { TS, Level, Sev, Msg, … }. */
  fields: Record<string, string>;
  /** The entry's own XML, serialized (formatted lazily for the hover panel). */
  xml: string;
}

export interface RunLogParsed {
  /** Field names present, in a stable display order. */
  columns: string[];
  /** Distinct `Sev` values present, in first-seen order. */
  sevValues: string[];
  entries: RunLogEntry[];
}

/** Preferred column order; unknown fields are appended in first-seen order. */
const COLUMN_ORDER = [
  "TS",
  "Level",
  "Sev",
  "LgNm",
  "ANm",
  "Data",
  "Tag",
  "MsgNm",
  "Msg",
  "Stack",
];

export function parseRunLog(xml: string): RunLogParsed {
  const body = xml
    .replace(/^﻿/, "")
    .trim()
    .replace(/^<\?xml[^>]*\?>/i, "")
    .trim();
  const doc = new DOMParser().parseFromString(
    `<zpcrweb-root>${body}</zpcrweb-root>`,
    "application/xml",
  );
  if (doc.querySelector("parsererror") || !doc.documentElement) {
    return { columns: [], sevValues: [], entries: [] };
  }

  const logs = Array.from(doc.documentElement.children).filter(
    (el) => el.tagName === "Log",
  );
  const nodes = logs.length ? logs : Array.from(doc.documentElement.children);

  const present = new Set<string>();
  const sevValues: string[] = [];
  const serializer = new XMLSerializer();

  const entries: RunLogEntry[] = nodes.map((el) => {
    const fields: Record<string, string> = {};
    for (const child of Array.from(el.children)) {
      fields[child.tagName] = (child.textContent ?? "").trim();
      present.add(child.tagName);
    }
    const sev = fields["Sev"];
    if (sev && !sevValues.includes(sev)) sevValues.push(sev);
    return { fields, xml: serializer.serializeToString(el) };
  });

  const columns = [
    ...COLUMN_ORDER.filter((c) => present.has(c)),
    ...[...present].filter((c) => !COLUMN_ORDER.includes(c)),
  ];

  return { columns, sevValues, entries };
}

/** `2026-07-20T13:18:18.000-08:00` → `2026-07-20 13:18:18` (wall-clock as recorded). */
export function friendlyTimestamp(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : raw;
}
