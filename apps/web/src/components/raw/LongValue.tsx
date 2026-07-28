import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * A decoded field's value, truncated to one line in the table and shown in full in a hover card.
 *
 * The raw views render values the library read out of a file, and their length is entirely up to
 * the instrument: a `.pcrd` header element can hold a serial-number list or a free-text
 * provenance note hundreds of characters long, next to a `Cycle` of `12`. Widening the column to
 * fit the longest one wrecks the table for every other row, and the previous behaviour — CSS
 * `text-overflow: ellipsis` alone — cut the text off with no way at all to read the rest.
 *
 * So the cell keeps its single ellipsized line, and hovering it opens a card that line-wraps the
 * value across a readable measure. Short values (the overwhelming majority) render as plain text
 * with no card and no hover target, so nothing moves for them.
 */

/** Values at or under this many characters fit a table cell comfortably and get no card. */
const INLINE_MAX = 40;

export function LongValue({ value }: { value: string }) {
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  if (value.length <= INLINE_MAX) return <span className="decoded__ftext">{value}</span>;

  return (
    <>
      <span
        className="decoded__ftext decoded__ftext--long"
        tabIndex={0}
        onMouseEnter={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ left: r.left, bottom: r.bottom });
        }}
        onMouseLeave={() => setAnchor(null)}
        // Keyboard parity: the card is the only way to read the full value, so it must not be
        // mouse-only. Focus/blur mirror enter/leave exactly.
        onFocus={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ left: r.left, bottom: r.bottom });
        }}
        onBlur={() => setAnchor(null)}
      >
        {value}
      </span>
      {anchor &&
        createPortal(
          // Fixed-position portal, like `curves/HoverCard`: the raw view's tables scroll inside
          // `.decoded__gridwrap`, so an absolutely-positioned child would be clipped by it.
          <div
            className="valuecard mono"
            style={{ position: "fixed", top: anchor.bottom + 6, left: anchor.left, zIndex: 50 }}
          >
            {value}
          </div>,
          document.body,
        )}
    </>
  );
}
