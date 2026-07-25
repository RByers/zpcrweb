interface Props {
  enabled: Set<number>;
  /** Number of reference columns to offer (from the plate width). */
  columns: number;
  onToggle: (col: number) => void;
  /** Enable only this column, disabling all others. */
  onOnly: (col: number) => void;
}

/** Reference-column chip bar, styled like {@link ChannelBar} but selecting plate columns
 * (R1–R12) instead of optical channels — see the Reference view. Each chip also carries a
 * small "only" button that isolates that one column. */
export function RefColBar({ enabled, columns, onToggle, onOnly }: Props) {
  return (
    <div className="chanbar">
      {Array.from({ length: columns }, (_, col) => {
        const on = enabled.has(col);
        return (
          <div
            key={col}
            className={"chanchip refchip" + (on ? " is-on" : "")}
            style={{ ["--chan" as string]: "var(--neon-magenta)" }}
          >
            <button
              className="refchip__toggle"
              onClick={() => onToggle(col)}
              aria-pressed={on}
            >
              <span className="chanchip__swatch" />
              <span className="chanchip__label">
                <span className="chanchip__ch mono">R{col + 1}</span>
              </span>
            </button>
            <button
              className="refchip__only"
              onClick={() => onOnly(col)}
              title={`Show only R${col + 1}`}
            >
              only
            </button>
          </div>
        );
      })}
    </div>
  );
}
