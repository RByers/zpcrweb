import { CHANNEL_INFO, channelLabel } from "../../lib/channelColors";

interface Props {
  enabled: Set<number>;
  /** Channel indices to offer (from CHANNELMASK); others are hidden. */
  available: number[];
  onToggle: (channel: number) => void;
  onHover?: (channel: number | null) => void;
}

export function ChannelBar({ enabled, available, onToggle, onHover }: Props) {
  return (
    <div className="chanbar">
      {CHANNEL_INFO.filter((c) => available.includes(c.index)).map((c) => {
        const on = enabled.has(c.index);
        return (
          <button
            key={c.index}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(c.index)}
            onMouseEnter={() => onHover?.(c.index)}
            onMouseLeave={() => onHover?.(null)}
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
    </div>
  );
}
