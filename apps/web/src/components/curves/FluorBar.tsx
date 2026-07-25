import { channelColor } from "../../lib/channelColors";
import { useHoverCard, type HoverCardData } from "./HoverCard";

/** One chip's worth of data — a fluorophore or, in target view mode, a target/gene. */
export interface FluorChip {
  /** Toggle key, and the `disabled` set's membership key. */
  key: string;
  /** Primary label, e.g. the fluorophore or target name. */
  label: string;
  /** Secondary label shown below — the channel (fluorophore mode) or the fluorophore itself
   * (target mode). */
  sublabel: string;
  /** Optical channel — used only for coloring, so a channel's hue stays consistent between
   * channel-space and dye-space views. `null` when the chip covers more than one channel (a
   * target spanning several fluorophores), which colors it neutrally instead. */
  channel: number | null;
  /** False when no matching `.Dcal` calibration was found — shown dimmed and non-interactive,
   * so its absence from the plot is visible rather than silent. */
  calibrated: boolean;
}

interface Props {
  items: FluorChip[];
  /** Keys *not* shown; anything else calibrated is on. */
  disabled: Set<string>;
  onToggle: (key: string) => void;
  /** Hovering a chip (by its `key`, or `null` on leave) — drives the curve-chart highlight. */
  onHover?: (key: string | null) => void;
  /** Hover-card content for a chip's `key`, or `null`/undefined to show none. */
  cardData?: (key: string) => HoverCardData | null | undefined;
}

/**
 * One chip per fluorophore or target (see {@link FluorChip}) present on the plate — colored by
 * its primary channel. Multiple items sharing a channel simply share a color, distinguished by
 * their label.
 */
export function FluorBar({ items, disabled, onToggle, onHover, cardData }: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
  return (
    <div className="chanbar">
      {items.map((f) => {
        const on = f.calibrated && !disabled.has(f.key);
        return (
          <button
            key={f.key}
            className={"chanchip" + (on ? " is-on" : "") + (!f.calibrated ? " is-disabled" : "")}
            onClick={() => f.calibrated && onToggle(f.key)}
            onMouseEnter={(e) => {
              onHover?.(f.key);
              show(f.key, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHover?.(null);
              hide();
            }}
            disabled={!f.calibrated}
            aria-pressed={on}
            title={!f.calibrated ? `${f.label}: no calibration data for this tube type` : f.label}
            style={{ ["--chan" as string]: channelColor(f.channel) }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{f.label}</span>
              <span className="chanchip__dye">{f.sublabel}</span>
            </span>
          </button>
        );
      })}
      {node}
    </div>
  );
}
