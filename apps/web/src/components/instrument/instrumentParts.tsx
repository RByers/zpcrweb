/**
 * The two small pieces the Instrument view's rail and its experiment panel both need: the
 * label/value stat row, and the "busy, but only for a beat" signal that keeps a button that queues
 * behind the USB channel from flashing its disabled look on every fast command.
 */
import { useEffect, useState } from "react";

/** One label/value row — the rail's readout idiom, also used for the running file's state in the
 * experiment panel's header so a reader (and a test) finds it the same way. */
export function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "warn" | "good";
  title?: string;
}) {
  return (
    <div className="devstat" title={title}>
      <span className="devstat__label">{label}</span>
      <span className={"devstat__value" + (tone ? ` devstat__value--${tone}` : "")}>{value}</span>
    </div>
  );
}

/**
 * True for the brief, purely transient window where `busy` is set but has not lasted long enough
 * to be worth showing as disabled.
 *
 * The USB command channel carries one request at a time, so every button that queues behind it
 * (Start, Stop, Pause/Resume) has to become *un-clickable* the instant any other command is in
 * flight — but a lid or indicator command round-trips fast enough that dimming a button for that
 * whole window reads as a flash rather than a state change. So only the dimmed *look* is delayed,
 * by 150 ms; each button's real `disabled` attribute never waits, and the race this guards against
 * still cannot happen. A caller adds its `--armed` class while this is true.
 */
export function useBusyBriefly(busy: string | null): boolean {
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (!busy) {
      setLingering(false);
      return;
    }
    const t = window.setTimeout(() => setLingering(true), 150);
    return () => window.clearTimeout(t);
  }, [busy]);
  return !!busy && !lingering;
}
