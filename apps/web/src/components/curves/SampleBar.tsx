interface Props {
  /** Distinct sample names present on the plate. */
  items: string[];
  /** Names *not* shown; anything else is on. */
  disabled: Set<string>;
  onToggle: (name: string) => void;
}

/** One chip per distinct sample name (`PlateDefinition.samples`) — toggles curves for wells
 * carrying that sample on/off, mirroring {@link import("./FluorBar").FluorBar}'s chips but
 * without a channel color, since a sample has no optical channel of its own. */
export function SampleBar({ items, disabled, onToggle }: Props) {
  return (
    <div className="chanbar">
      {items.map((name) => {
        const on = !disabled.has(name);
        return (
          <button
            key={name}
            className={"chanchip" + (on ? " is-on" : "")}
            onClick={() => onToggle(name)}
            aria-pressed={on}
            title={name}
            style={{ ["--chan" as string]: "var(--neon-cyan)" }}
          >
            <span className="chanchip__swatch" />
            <span className="chanchip__label">
              <span className="chanchip__ch mono">{name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
