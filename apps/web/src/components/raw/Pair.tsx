import type { ReactNode } from "react";

/**
 * One label/value row inside a `<dl className="decoded__dl">` — shared by every decoded raw
 * view (`.Dcal`, `.pltd`, `.prcl`, `.alf`) and the plate-map well detail popover.
 *
 * `v` takes a node, not just a string, so a view can mark a value up without dropping out of this
 * row — an empty field shown as a dimmed `∅` rather than skipped, which the raw views need.
 */
export function Pair({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="decoded__pair">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
