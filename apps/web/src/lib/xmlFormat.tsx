import type { ReactNode } from "react";

/**
 * Pretty-print an XML string into indented, syntax-highlighted React nodes. Uses the
 * browser's DOMParser (no dependency); on a parse error, returns null so the caller can
 * fall back to raw text. Rendered inside a `white-space: pre` container: each element is a
 * line, indentation is leading spaces, and tokens are wrapped in `.xml-*` spans for CSS
 * highlighting.
 */
export function formatXml(xml: string): ReactNode | null {
  // Some CFX files (e.g. runlog.xml) are not single-rooted: a BOM, then an empty header
  // element followed by many sibling <Log> records with no wrapping root. Strip the BOM and
  // any XML declaration, then wrap in a synthetic root so DOMParser accepts the fragment;
  // render its children (the real top-level records), not the wrapper.
  const body = xml
    .replace(/^﻿/, "")
    .trim()
    .replace(/^<\?xml[^>]*\?>/i, "")
    .trim();
  const doc = new DOMParser().parseFromString(
    `<zpcrweb-root>${body}</zpcrweb-root>`,
    "application/xml",
  );
  if (doc.querySelector("parsererror") || !doc.documentElement) return null;
  const children = Array.from(doc.documentElement.children);
  if (children.length === 0) return null;
  return <>{children.map((c, i) => renderElement(c, 0, `r${i}`))}</>;
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

function renderElement(el: Element, depth: number, key: string): ReactNode {
  const elementChildren = Array.from(el.children);
  const text = (el.textContent ?? "").trim();

  // Leaf element (no child elements).
  if (elementChildren.length === 0) {
    if (text === "") {
      return (
        <div key={key}>
          {pad(depth)}
          {openTag(el, true)}
        </div>
      );
    }
    return (
      <div key={key}>
        {pad(depth)}
        {openTag(el, false)}
        <span className="xml-text">{text}</span>
        {closeTag(el)}
      </div>
    );
  }

  // Container element: open, nested children, close.
  return (
    <div key={key}>
      <div>
        {pad(depth)}
        {openTag(el, false)}
      </div>
      {elementChildren.map((c, i) => renderElement(c, depth + 1, `${key}-${i}`))}
      <div>
        {pad(depth)}
        {closeTag(el)}
      </div>
    </div>
  );
}
