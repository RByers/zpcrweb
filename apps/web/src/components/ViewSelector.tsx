import type { ViewId } from "../state/useZpcrStore";

const ALL_VIEWS: { id: ViewId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "curves", label: "Curves" },
  { id: "plates", label: "Plates" },
  { id: "reference", label: "Reference" },
  { id: "raw", label: "Raw files" },
];

interface Props {
  value: ViewId;
  onChange: (v: ViewId) => void;
  /** Restrict the tab set, e.g. `["plates", "raw"]` for a standalone `.pltd`/`.plt.csv` entry.
   * Defaults to every tab (a `.zpcr`/`.pcrd` run). */
  views?: ViewId[];
}

export function ViewSelector({ value, onChange, views }: Props) {
  const shown = views ? ALL_VIEWS.filter((v) => views.includes(v.id)) : ALL_VIEWS;
  return (
    <div className="segmented" role="tablist" aria-label="View">
      {shown.map((v) => (
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
