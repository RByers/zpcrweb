import { CHANNEL_INFO, channelLabel } from "../../lib/channelColors";
import { useHoverCard, type HoverCardData } from "./HoverCard";

interface Props {
  enabled: Set<number>;
  /** Channel indices to offer (from CHANNELMASK); others are hidden. */
  available: number[];
  onToggle: (channel: number) => void;
  onHover?: (channel: number | null) => void;
  /** Hover-card content for a channel, or `null`/undefined to show none. */
  cardData?: (channel: number) => HoverCardData | null | undefined;
}

export function ChannelBar({ enabled, available, onToggle, onHover, cardData }: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
  return (
    <div className="chanbar">
      {CHANNEL_INFO.filter((c) => available.includes(c.index)).map((c) => {
        const on = enabled.has(c.index);
        return (
          <button
            key={c.index}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(c.index)}
            onMouseEnter={(e) => {
              onHover?.(c.index);
              show(c.index, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHover?.(null);
              hide();
            }}
            aria-pressed={on}
            style={{ ["--chan" as string]: c.color }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{channelLabel(c.index)}</span>
            </span>
          </button>
        );
      })}
      {node}
    </div>
  );
}
