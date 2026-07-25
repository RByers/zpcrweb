interface Props {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}

/** A small on/off switch — a label with a little toggle track to its right. */
export function Switch({ label, checked, onChange, title }: Props) {
  return (
    <button
      type="button"
      className={"switch" + (checked ? " is-on" : "")}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      title={title}
    >
      <span className="switch__label">{label}</span>
      <span className="switch__track" />
    </button>
  );
}
