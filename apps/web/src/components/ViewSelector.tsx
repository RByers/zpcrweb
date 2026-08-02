import type { ViewId } from "../state/useZpcrStore";
import {
  CalibrationIcon,
  CurvesIcon,
  FilesIcon,
  InstrumentIcon,
  OverviewIcon,
  PlatesIcon,
  ProtocolIcon,
  RawIcon,
  ReferenceIcon,
} from "./ViewIcons";

const ALL_VIEWS: { id: ViewId; label: string; Icon: () => React.ReactElement }[] = [
  { id: "overview", label: "Overview", Icon: OverviewIcon },
  { id: "protocol", label: "Protocol", Icon: ProtocolIcon },
  { id: "curves", label: "Curves", Icon: CurvesIcon },
  { id: "plates", label: "Plates", Icon: PlatesIcon },
  { id: "reference", label: "Reference", Icon: ReferenceIcon },
  { id: "calibration", label: "Calibration", Icon: CalibrationIcon },
  { id: "raw", label: "Raw", Icon: RawIcon },
];

/**
 * The Files tab, kept out of {@link ALL_VIEWS} and rendered in its own group, first — the same
 * treatment {@link INSTRUMENT_VIEW} gets, and for the same reason: it isn't a lens on the active
 * file, it's a lens on every loaded file, so grouping it with the rest would say the file
 * selection applies to it. Green (`--good`) rather than Instrument's magenta, so the two
 * "different kind of tab" groups still read as different from each other, not just from the rest.
 */
const FILES_VIEW = { id: "files" as ViewId, label: "Files", Icon: FilesIcon };

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
  /** Which file-backed tabs the active file supports, e.g. `["plates", "raw"]` for a standalone
   * `.pltd`/`.plt.csv` entry. Defaults to every tab (a `.zpcr`/`.pcrd` run).
   *
   * **The tab strip is the same seven tabs whatever the answer is** — a file the tab doesn't apply
   * to disables it rather than removing it. A tab set that changed shape per file moved every
   * other tab under the pointer each time the selection changed, and hid the fact that the strip
   * is the app's fixed set of lenses rather than a per-file menu. Greying out says "not for this
   * file"; disappearing says nothing at all.
   *
   * Does not affect the Instrument tab, which is not file-backed and is always enabled. */
  enabled?: readonly ViewId[];
}

export function ViewSelector({ value, onChange, enabled }: Props) {
  const tab = (v: (typeof ALL_VIEWS)[number], off = false) => (
    <button
      key={v.id}
      role="tab"
      aria-selected={value === v.id}
      disabled={off}
      // The label is hidden on a narrow viewport (`app.css`), so name the tab explicitly:
      // `aria-label` keeps it readable to a screen reader either way, and `title` gives a
      // pointer user the word back on hover — and, when the tab is off, the reason it is.
      aria-label={off ? `${v.label} — not available for this file` : v.label}
      title={off ? `${v.label} — not available for this file` : v.label}
      className={"segmented__item" + (value === v.id ? " is-active" : "")}
      onClick={() => onChange(v.id)}
    >
      <v.Icon />
      <span className="segmented__label">{v.label}</span>
    </button>
  );

  return (
    <div className="viewselect" role="tablist" aria-label="View">
      <div className="segmented segmented--files">{tab(FILES_VIEW)}</div>
      <div className="segmented">
        {ALL_VIEWS.map((v) => tab(v, !!enabled && !enabled.includes(v.id)))}
      </div>
      <div className="segmented segmented--instrument">{tab(INSTRUMENT_VIEW)}</div>
    </div>
  );
}
