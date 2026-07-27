import { useMemo, useState, type ReactNode } from "react";

/**
 * Shared XML rendering for every place the app shows XML: the generic raw-file fallback, a
 * decrypted `.pltd`'s payload, `runlog.xml`'s per-entry tooltip, and `.pcrd`'s document tree.
 * One implementation so collapse/expand behavior and styling stay consistent everywhere.
 *
 * Uses the browser's `DOMParser` (no dependency) — presentation-only, so this stays in the
 * app rather than `@zpcrweb/core` (see `apps/web/ARCHITECTURE.md`). Large subtrees (a `.pcrd`
 * document's `calibrationCollection` is ~1.4 MB of deeply nested elements) are rendered lazily:
 * each element is its own component with its own open/closed state, and children are only
 * mapped into React elements when their parent is open — a closed subtree costs ~O(1)
 * regardless of its size, since its descendants are never visited.
 */

/**
 * Parse an XML string into its root element, tolerant of non-single-rooted fragments (e.g. a
 * BOM followed by many sibling records with no wrapping root). Strips the BOM and any XML
 * declaration, then wraps the body in a synthetic root so `DOMParser` always accepts it;
 * returns that synthetic root (callers read `.children` for the real top-level content), or
 * `null` on a parse error or empty input.
 */
export function parseXmlFragment(xml: string): Element | null {
  const body = xml
    .replace(/^﻿/, "")
    .trim()
    .replace(/^<\?xml[^>]*\?>/i, "")
    .trim();
  if (body === "") return null;
  const doc = new DOMParser().parseFromString(
    `<zpcrweb-root>${body}</zpcrweb-root>`,
    "application/xml",
  );
  if (doc.querySelector("parsererror") || !doc.documentElement) return null;
  return doc.documentElement;
}

/**
 * True when `text` is an XML document — i.e. once a BOM and any XML declaration are out of the
 * way, the first non-space character opens a tag.
 *
 * This is what every raw text view uses to decide between `<XmlTreeFromString>` and a plain
 * `<pre>`, deliberately sniffing the content rather than trusting the file name. Extensions
 * lie in both directions here: a `.zpcr`'s `.alf` and `ProtocolRunDefinition.txt` are
 * line-oriented plain text, while the payload decrypted out of a `.pltd`/`.prcl` is XML that
 * never had a `.xml` name to begin with.
 */
export function looksLikeXml(text: string): boolean {
  return /^\s*</.test(
    text.replace(/^﻿/, "").replace(/^\s*<\?xml[^>]*\?>/i, ""),
  );
}

function pad(depth: number): string {
  return "  ".repeat(depth);
}

function openTag(el: Element, selfClose: boolean): ReactNode {
  const attrs = Array.from(el.attributes);
  return (
    <>
      <span className="xml-punct">&lt;</span>
      <span className="xml-tag">{el.tagName}</span>
      {attrs.map((a, i) => (
        <span key={i}>
          {" "}
          <span className="xml-attr">{a.name}</span>
          <span className="xml-punct">=</span>
          <span className="xml-val">"{a.value}"</span>
        </span>
      ))}
      <span className="xml-punct">{selfClose ? " />" : ">"}</span>
    </>
  );
}

function closeTag(el: Element): ReactNode {
  return (
    <>
      <span className="xml-punct">&lt;/</span>
      <span className="xml-tag">{el.tagName}</span>
      <span className="xml-punct">&gt;</span>
    </>
  );
}

// A node opens by default when it has few enough children that expanding it stays readable.
const DEFAULT_OPEN_MAX_CHILDREN = 4;

/**
 * `forceOpen` overrides the child-count rule for a document's own root element: landing on a
 * lone collapsed `<RunInfo> 66 children` line shows nothing about the file you just opened, and
 * the first thing anyone does is click it. So the root always starts open, however wide.
 *
 * It applies only to a *single* root. A fragment with many top-level siblings (`runlog.xml` is
 * 92 `<Log>` records, `.pcrd`'s `logEls` likewise) has no root element to speak of, and opening
 * every sibling would defeat the collapsing entirely — those keep the child-count rule.
 */
function defaultOpen(el: Element, forceOpen: boolean): boolean {
  return forceOpen || el.children.length <= DEFAULT_OPEN_MAX_CHILDREN;
}

function TreeNode({
  el,
  depth,
  forceOpen = false,
}: {
  el: Element;
  depth: number;
  forceOpen?: boolean;
}) {
  const elementChildren = Array.from(el.children);
  const initialOpen = useMemo(() => defaultOpen(el, forceOpen), [el, forceOpen]);
  const [open, setOpen] = useState(initialOpen);

  if (elementChildren.length === 0) {
    const text = (el.textContent ?? "").trim();
    if (text === "") {
      return (
        <div>
          {pad(depth)}
          {openTag(el, true)}
        </div>
      );
    }
    return (
      <div>
        {pad(depth)}
        {openTag(el, false)}
        <span className="xml-text">{text}</span>
        {closeTag(el)}
      </div>
    );
  }

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {pad(depth)}
        {openTag(el, false)}
        {!open && (
          <span className="xml-count">
            {" "}
            {elementChildren.length} {elementChildren.length === 1 ? "child" : "children"}
          </span>
        )}
      </summary>
      {open && (
        <>
          {elementChildren.map((c, i) => (
            <TreeNode key={i} el={c} depth={depth + 1} />
          ))}
          <div>
            {pad(depth)}
            {closeTag(el)}
          </div>
        </>
      )}
    </details>
  );
}

/** Render a set of top-level XML elements as a collapsible tree. A lone root is always
 * expanded (see {@link defaultOpen}); a multi-root fragment is left to the child-count rule. */
export function XmlTree({ roots }: { roots: Element[] }) {
  return (
    <div className="decoded__xml mono">
      {roots.map((r, i) => (
        <TreeNode key={i} el={r} depth={0} forceOpen={roots.length === 1} />
      ))}
    </div>
  );
}

/** Convenience: parse an XML string and render it as a collapsible tree, falling back to raw
 * text on a parse error or empty input. */
export function XmlTreeFromString({ xml }: { xml: string }) {
  const root = useMemo(() => parseXmlFragment(xml), [xml]);
  const roots = root ? Array.from(root.children) : [];
  if (roots.length === 0) return <pre className="decoded__xml mono">{xml}</pre>;
  return <XmlTree roots={roots} />;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function serializeNode(el: Element, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth);
  const attrs = Array.from(el.attributes)
    .map((a) => ` ${a.name}="${escapeAttr(a.value)}"`)
    .join("");
  const children = Array.from(el.children);
  if (children.length === 0) {
    const text = (el.textContent ?? "").trim();
    lines.push(
      text === ""
        ? `${indent}<${el.tagName}${attrs} />`
        : `${indent}<${el.tagName}${attrs}>${escapeText(text)}</${el.tagName}>`,
    );
    return;
  }
  lines.push(`${indent}<${el.tagName}${attrs}>`);
  for (const c of children) serializeNode(c, depth + 1, lines);
  lines.push(`${indent}</${el.tagName}>`);
}

/** Pretty-print a set of top-level XML elements as indented text (2 spaces/level), fully
 * expanded — used for downloading a `.pcrd` document subtree, which `<XmlTree>` only ever
 * renders lazily/collapsibly. */
export function serializeXmlPretty(roots: Element[]): string {
  const lines: string[] = [];
  for (const r of roots) serializeNode(r, 0, lines);
  return lines.join("\n");
}
