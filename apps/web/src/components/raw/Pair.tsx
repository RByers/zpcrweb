/**
 * One label/value row inside a `<dl className="decoded__dl">` — shared by every decoded raw
 * view (`.Dcal`, `.pltd`, `.prcl`) and the plate-map well detail popover.
 */
export function Pair({ k, v }: { k: string; v: string }) {
  return (
    <div className="decoded__pair">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
