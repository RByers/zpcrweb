interface Props {
  enabled: Set<number>;
  /** Number of reference columns to offer (from the plate width). */
  columns: number;
  onToggle: (col: number) => void;
}

/** Reference-column chip bar, styled like {@link ChannelBar} but selecting plate columns
 * (R1–R12) instead of optical channels — see the Diagnostics view. */
export function RefColBar({ enabled, columns, onToggle }: Props) {
  return (
    <div className="chanbar">
      {Array.from({ length: columns }, (_, col) => {
        const on = enabled.has(col);
        return (
          <button
            key={col}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(col)}
            aria-pressed={on}
            style={{ ["--chan" as string]: "var(--neon-magenta)" }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">R{col + 1}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
