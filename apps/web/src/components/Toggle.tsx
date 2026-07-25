export function Toggle({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle">
      <div className="toggle__label">{label}</div>
      <div className="segmented segmented--sm">
        {options.map(([val, text]) => (
          <button
            key={val}
            className={"segmented__item" + (value === val ? " is-active" : "")}
            disabled={disabled}
            onClick={() => onChange(val)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
