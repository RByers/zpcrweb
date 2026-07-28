import { CHANNEL_INFO, channelLabel } from "../../lib/channelColors";
import { ChipBar } from "./ChipBar";
import type { HoverCardData } from "./HoverCard";

interface Props {
  enabled: Set<number>;
  /** Channel indices to offer (from CHANNELMASK); others are hidden. */
  available: number[];
  onToggle: (channel: number) => void;
  onHover?: (channel: number | null) => void;
  /** Double-clicking a chip — isolates it: only this channel stays enabled. */
  onSolo?: (channel: number) => void;
  /** Hover-card content for a channel, or `null`/undefined to show none. */
  cardData?: (channel: number) => HoverCardData | null | undefined;
}

/** One chip per optical channel, over the shared {@link ChipBar} — so channels toggle, solo and
 * peek exactly like every other rail selection. */
export function ChannelBar({ enabled, available, onToggle, onHover, onSolo, cardData }: Props) {
  return (
    <ChipBar
      chips={CHANNEL_INFO.filter((c) => available.includes(c.index)).map((c) => ({
        key: String(c.index),
        label: channelLabel(c.index),
        color: c.color,
        on: enabled.has(c.index),
      }))}
      onToggle={(key) => onToggle(Number(key))}
      onHover={onHover && ((key) => onHover(key == null ? null : Number(key)))}
      onSolo={onSolo && ((key) => onSolo(Number(key)))}
      cardData={cardData && ((key) => cardData(Number(key)))}
    />
  );
}
