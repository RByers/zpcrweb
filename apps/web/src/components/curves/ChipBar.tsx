import { useHoverCard, type HoverCardData } from "./HoverCard";

/** One chip in a {@link ChipBar} — whatever the bar is selecting (a channel, a fluorophore, a
 * target, a sample, a reference column), reduced to what the chip itself needs to draw. */
export interface Chip {
  /** Identity: the key `enabled`/`onToggle`/`onHover`/`onSolo`/`cardData` all speak in. */
  key: string;
  /** Primary label — the big line. */
  label: string;
  /** Optional secondary label below it (channel, fluorophore, …). */
  sublabel?: string;
  /** Swatch/accent color, as a CSS color or `var()`. */
  color: string;
  /** Whether the chip is currently plotted. */
  on: boolean;
  /** False makes the chip dimmed and non-interactive — used for a fluorophore with no matching
   * calibration, so its absence from the plot is visible rather than silent. Default true. */
  selectable?: boolean;
  /** Native tooltip; falls back to the label. */
  title?: string;
}

interface Props {
  chips: Chip[];
  /** Clicking a chip — toggles it. */
  onToggle: (key: string) => void;
  /** Hovering a chip (`null` on leave). Drives both the chart's highlight-dimming and the
   * "peek": every view lets the hovered chip's curves through its own disabled check, so
   * hovering a turned-off chip shows it temporarily. */
  onHover?: (key: string | null) => void;
  /** Double-clicking a chip — isolates it: only this one stays enabled. */
  onSolo?: (key: string) => void;
  /** Hover-card content for a chip's `key`, or `null`/undefined to show none. */
  cardData?: (key: string) => HoverCardData | null | undefined;
}

/**
 * The rail's chip bar — the one grid of toggleable chips every selection rail in the app is
 * built from: channels ({@link import("./ChannelBar").ChannelBar}), fluorophores/targets
 * ({@link import("./FluorBar").FluorBar}), samples ({@link import("./SampleBar").SampleBar}) and
 * the Reference view's plate columns ({@link import("./RefColBar").RefColBar}).
 *
 * Those four are thin adapters that map their own domain onto {@link Chip}; the interaction
 * contract lives here and is therefore identical everywhere: click toggles, double-click solos,
 * hover peeks at a disabled chip and dims the rest of the chart, and a hover card lists what the
 * chip covers. Each rail pairs the bar with its own reset button, which is a property of the
 * default selection rather than of the chips, so it stays in the view.
 */
export function ChipBar({ chips, onToggle, onHover, onSolo, cardData }: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
  return (
    <div className="chanbar">
      {chips.map((c) => {
        const selectable = c.selectable !== false;
        return (
          <button
            key={c.key}
            className={
              "chanchip" + (c.on ? " is-on" : "") + (!selectable ? " is-disabled" : "")
            }
            onClick={() => selectable && onToggle(c.key)}
            onDoubleClick={() => selectable && onSolo?.(c.key)}
            onMouseEnter={(e) => {
              onHover?.(c.key);
              show(c.key, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHover?.(null);
              hide();
            }}
            disabled={!selectable}
            aria-pressed={c.on}
            title={c.title ?? c.label}
            style={{ ["--chan" as string]: c.color }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{c.label}</span>
              {c.sublabel != null && <span className="chanchip__dye">{c.sublabel}</span>}
            </span>
          </button>
        );
      })}
      {node}
    </div>
  );
}
