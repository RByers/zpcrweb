import { parseXmlFragment } from "./xmlTree";

/**
 * Parse CFX run-log records into structured entries. `.zpcr`'s real `runlog.xml` is not
 * single-rooted (a BOM, an empty header element, then many sibling `<Log>` records with no
 * wrapper), each record a child-element bag (`<Log><TS>…</TS><Msg>…</Msg></Log>`); a `.pcrd`
 * document's real `<log>` records are attribute-only (`<log ts="…" msg="…" />`) — see
 * `pcrd.md`. Both shapes are supported directly (not by reshaping one into the other) so
 * either format's real elements can be handed straight to {@link logEntriesFromElements}.
 * Presentation-side parsing (a log viewer), kept in the app.
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

/** A `.pcrd` `<log>` element's real attribute names → `.zpcr`'s real `<Log>` child-element
 * names. Not a casing difference (`assemblyName` → `ANm` is a different abbreviation), so an
 * explicit map rather than a case-insensitive lookup. Unmapped attribute names pass through
 * unchanged, so an unfamiliar field still shows up rather than being dropped. */
const PCRD_LOG_ATTR_TO_COLUMN: Record<string, string> = {
  ts: "TS",
  level: "Level",
  sev: "Sev",
  lgNm: "LgNm",
  assemblyName: "ANm",
  data: "Data",
  tag: "Tag",
  msgNm: "MsgNm",
  msg: "Msg",
  stack: "Stack",
};

function fieldsFromElement(el: Element): Record<string, string> {
  const fields: Record<string, string> = {};
  if (el.attributes.length > 0) {
    for (const attr of Array.from(el.attributes)) {
      fields[PCRD_LOG_ATTR_TO_COLUMN[attr.name] ?? attr.name] = attr.value;
    }
    return fields;
  }
  for (const child of Array.from(el.children)) {
    fields[child.tagName] = (child.textContent ?? "").trim();
  }
  return fields;
}

/** Build entries from real `<Log>`/`<log>` elements, in either shape. */
export function logEntriesFromElements(elements: Element[]): RunLogEntry[] {
  const serializer = new XMLSerializer();
  return elements.map((el) => ({
    fields: fieldsFromElement(el),
    xml: serializer.serializeToString(el),
  }));
}

/** Compute the column order and distinct severities across a set of entries. */
export function summarizeRunLog(entries: RunLogEntry[]): RunLogParsed {
  const present = new Set<string>();
  const sevValues: string[] = [];
  for (const e of entries) {
    for (const k of Object.keys(e.fields)) present.add(k);
    const sev = e.fields["Sev"];
    if (sev && !sevValues.includes(sev)) sevValues.push(sev);
  }
  const columns = [
    ...COLUMN_ORDER.filter((c) => present.has(c)),
    ...[...present].filter((c) => !COLUMN_ORDER.includes(c)),
  ];
  return { columns, sevValues, entries };
}

/** Parse a `.zpcr` `runlog.xml` string into structured log entries. */
export function parseRunLog(xml: string): RunLogParsed {
  const root = parseXmlFragment(xml);
  if (!root) return { columns: [], sevValues: [], entries: [] };
  const children = Array.from(root.children);
  const logs = children.filter((el) => el.tagName.toLowerCase() === "log");
  return summarizeRunLog(logEntriesFromElements(logs.length ? logs : children));
}

/** `2026-07-20T13:18:18.000-08:00` → `2026-07-20 13:18:18` (wall-clock as recorded). */
export function friendlyTimestamp(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : raw;
}
