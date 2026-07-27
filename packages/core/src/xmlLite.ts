/**
 * Minimal, hand-rolled XML scanning shared by every CFX XML payload: `.pltd`/`.prcl`
 * (`pltd.ts`) and `.pcrd` (`pcrd.ts`). Not a general XML parser — CFX's own serializer
 * produces regular, well-formed output (quoted attributes, no CDATA observed), so a small
 * regex-driven scanner is sufficient and keeps the library dependency-free.
 */

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Parse `key="value"` attributes from a tag's interior, XML-unescaping values. */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) attrs[m[1]!] = unescapeXml(m[2]!);
  return attrs;
}

/** Attributes of the first `<tagName …>` occurrence (case-insensitive tag match). */
export function firstTagAttrs(xml: string, tagName: string): Record<string, string> {
  const m = new RegExp(`<${tagName}\\b([^>]*)>`, "i").exec(xml);
  return m ? parseAttrs(m[1]!) : {};
}

/** Attributes of every `<tagName …>`/`<tagName …/>` occurrence (case-insensitive). */
export function allTagAttrs(xml: string, tagName: string): Record<string, string>[] {
  const re = new RegExp(`<${tagName}\\b([^>]*?)/?>`, "gi");
  const out: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(parseAttrs(m[1]!));
  return out;
}

/** Text content of the first `<tagName>…</tagName>` leaf element, or undefined. */
export function firstTagText(xml: string, tagName: string): string | undefined {
  const m = new RegExp(`<${tagName}(?:\\s[^>]*)?>([^<]*)</${tagName}>`, "i").exec(xml);
  return m ? unescapeXml(m[1]!) : undefined;
}

/** Strip a leading UTF-8 BOM (`EF BB BF`) before decoding, e.g. inflated CFX XML payloads. */
export function stripBomBytes(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3)
    : bytes;
}

/** One depth-0 child element found by {@link splitElements}. */
export interface XmlElement {
  /** Element/tag name, original case. */
  name: string;
  /** Attributes on the opening tag. */
  attrs: Record<string, string>;
  /** Inner text between the opening and closing tag (empty for a self-closing element). */
  inner: string;
}

// Matches one tag: open, close, or self-closing. The attrs group consumes quoted strings as
// a single unit so a `>` inside an attribute value (e.g. a log message) can't be mistaken for
// the tag's end.
const TAG_RE = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g;

/**
 * Split `xml` into its depth-0 child elements — the direct children of whatever (unwritten)
 * root contains `xml`. Used to walk a large CFX document one level at a time (root →
 * `runData` → `plateReadDataVector` → each `plateRead`) without a full DOM, so multi-megabyte
 * documents stay cheap to navigate.
 */
export function splitElements(xml: string): XmlElement[] {
  const out: XmlElement[] = [];
  let depth = 0;
  let curName = "";
  let curAttrs: Record<string, string> = {};
  let innerStart = 0;

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const [full, closing, name, attrsRaw, selfClose] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (depth === 0 && !closing) {
      curName = name;
      curAttrs = parseAttrs(attrsRaw);
      innerStart = m.index + full.length;
      if (selfClose) {
        out.push({ name: curName, attrs: curAttrs, inner: "" });
      } else {
        depth = 1;
      }
      continue;
    }
    if (depth === 0) continue; // stray close tag at the root — ignore
    if (!closing && !selfClose) {
      depth++;
    } else if (closing) {
      depth--;
      if (depth === 0) {
        out.push({ name: curName, attrs: curAttrs, inner: xml.slice(innerStart, m.index) });
      }
    }
  }
  return out;
}

/** Find the first depth-0 child named `name` (case-insensitive), or undefined. */
export function findElement(xml: string, name: string): XmlElement | undefined {
  return splitElements(xml).find((e) => e.name.toLowerCase() === name.toLowerCase());
}
