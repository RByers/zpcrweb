import type { ViewId } from "../state/useZpcrStore";
import {
  CalibrationIcon,
  CurvesIcon,
  InstrumentIcon,
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

/**
 * The Instrument tab, kept out of {@link ALL_VIEWS} and rendered in its own group.
 *
 * Every other tab is a lens on the **active file**; this one talks to an instrument over USB and
 * is the only view that works — and is worth reaching — with nothing loaded at all. Grouping it
 * with the rest would say the file selection applies to it, which is exactly what the separator
 * and the `views` restriction below exist to deny. `App` hides the file bar while it's showing,
 * for the same reason.
 */
const INSTRUMENT_VIEW = { id: "instrument" as ViewId, label: "Instrument", Icon: InstrumentIcon };

interface Props {
  value: ViewId;
  onChange: (v: ViewId) => void;
  /** Restrict the file-backed tab set, e.g. `["plates", "raw"]` for a standalone `.pltd`/`.plt.csv`
   * entry. Defaults to every tab (a `.zpcr`/`.pcrd` run). Does not affect the Instrument tab,
   * which is not file-backed. */
  views?: ViewId[];
}

export function ViewSelector({ value, onChange, views }: Props) {
  const shown = views ? ALL_VIEWS.filter((v) => views.includes(v.id)) : ALL_VIEWS;
  const tab = (v: (typeof ALL_VIEWS)[number]) => (
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
  );

  return (
    <div className="viewselect" role="tablist" aria-label="View">
      {shown.length > 0 && <div className="segmented">{shown.map(tab)}</div>}
      <div className="segmented segmented--instrument">{tab(INSTRUMENT_VIEW)}</div>
    </div>
  );
}
