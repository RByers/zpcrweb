import type { ViewId } from "../state/useZpcrStore";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "curves", label: "Curves" },
  { id: "raw", label: "Raw files" },
];

interface Props {
  value: ViewId;
  onChange: (v: ViewId) => void;
}

export function ViewSelector({ value, onChange }: Props) {
  return (
    <div className="segmented" role="tablist" aria-label="View">
      {VIEWS.map((v) => (
        <button
          key={v.id}
          role="tab"
          aria-selected={value === v.id}
          className={"segmented__item" + (value === v.id ? " is-active" : "")}
          onClick={() => onChange(v.id)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
