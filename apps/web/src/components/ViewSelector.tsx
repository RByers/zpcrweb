import type { ViewId } from "../state/useZpcrStore";
import {
  CalibrationIcon,
  CurvesIcon,
  OverviewIcon,
  PlatesIcon,
  RawIcon,
  ReferenceIcon,
} from "./ViewIcons";

const ALL_VIEWS: { id: ViewId; label: string; Icon: () => React.ReactElement }[] = [
  { id: "overview", label: "Overview", Icon: OverviewIcon },
  { id: "curves", label: "Curves", Icon: CurvesIcon },
  { id: "plates", label: "Plates", Icon: PlatesIcon },
  { id: "reference", label: "Reference", Icon: ReferenceIcon },
  { id: "calibration", label: "Calibration", Icon: CalibrationIcon },
  { id: "raw", label: "Raw files", Icon: RawIcon },
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
          // The label is hidden on a narrow viewport (`app.css`), so name the tab explicitly:
          // `aria-label` keeps it readable to a screen reader either way, and `title` gives a
          // pointer user the word back on hover.
          aria-label={v.label}
          title={v.label}
          className={"segmented__item" + (value === v.id ? " is-active" : "")}
          onClick={() => onChange(v.id)}
        >
          <v.Icon />
          <span className="segmented__label">{v.label}</span>
        </button>
      ))}
    </div>
  );
}
