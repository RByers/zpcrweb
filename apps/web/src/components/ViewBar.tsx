/**
 * The **view bar** — the app's tab strip, and the counterpart of the **file bar** below it
 * (`FileBar.tsx`). Those two names are how the rest of the codebase and its docs refer to these
 * surfaces; see `apps/web/ARCHITECTURE.md`, "Files, loaded files, and the one selection".
 *
 * It has three groups, and the split says what each is a lens on:
 *
 * - **Files** — the catalog, every file the browser holds (`FilesTableView.tsx`). Not tied to the
 *   selection, so it is always enabled: with nothing selected it is where you go to select
 *   something.
 * - **the file views** — Overview through Raw. Every one of these is a lens on the **one selected
 *   file**, so the whole group is disabled when nothing is selected, and individual tabs are
 *   disabled when they don't apply to the file that is (`App.tsx`'s `enabledViewsFor`).
 * - **Instrument** — the cycler on the other end of the USB cable, and always enabled for the same
 *   reason Files is: what it shows exists whether or not a file is selected.
 *
 * Instrument spent a while in the middle group, on the argument that starting a run needs a
 * protocol and a protocol comes from a file. That is true and it is still where the protocol comes
 * from — but *needing a file as input* is not the same as *being a lens on the selected file*, and
 * only the second belongs in that group. The instrument keeps cycling, recording and being
 * followed while the selection moves around it; a lens re-reads when the selection changes, and
 * this tab must not. Grouping it with the lenses cost two contortions in `App` to paper over the
 * difference — the file bar's selection lock, and a snap-to-the-running-file on arrival — and both
 * are gone with the regrouping. Which experiment a run would start is now asked *in* the view,
 * where it is visible, rather than read off whichever chip happened to be lit.
 *
 * **The strip is the same nine tabs whatever the selection is.** A tab that doesn't apply is
 * disabled, never removed: a set that changed shape per file moved every other tab under the
 * pointer each time the selection changed, and hid the fact that this is the app's fixed set of
 * lenses rather than a per-file menu. Greying out says "not for this file"; disappearing says
 * nothing at all.
 */
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

interface Tab {
  id: ViewId;
  label: string;
  Icon: () => React.ReactElement;
}

/** The file views, in strip order — the tabs {@link Props.enabled} governs. */
const FILE_VIEWS: Tab[] = [
  { id: "overview", label: "Overview", Icon: OverviewIcon },
  { id: "protocol", label: "Protocol", Icon: ProtocolIcon },
  { id: "curves", label: "Curves", Icon: CurvesIcon },
  { id: "plates", label: "Plates", Icon: PlatesIcon },
  { id: "reference", label: "Reference", Icon: ReferenceIcon },
  { id: "calibration", label: "Calibration", Icon: CalibrationIcon },
  { id: "raw", label: "Raw", Icon: RawIcon },
];

/** The catalog tab, in its own group and always enabled — see the module comment. */
const FILES_VIEW: Tab = { id: "files", label: "Files", Icon: FilesIcon };

/** The instrument tab, likewise its own group and likewise always enabled: the cycler is there or
 * not there regardless of what the file bar has selected. */
const INSTRUMENT_VIEW: Tab = { id: "instrument", label: "Instrument", Icon: InstrumentIcon };

interface Props {
  value: ViewId;
  onChange: (v: ViewId) => void;
  /**
   * Which file views the selected file supports, e.g. `["overview", "plates", "raw"]` for a
   * standalone `.pltd`/`.plt.csv`. An **empty** array is the no-selection case: nothing applies,
   * so every file view greys out and only Files and Instrument remain — the two that were never
   * about the selection.
   */
  enabled: readonly ViewId[];
}

export function ViewBar({ value, onChange, enabled }: Props) {
  const tab = (v: Tab, off = false) => (
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
    <div className="viewbar" role="tablist" aria-label="View">
      <div className="segmented segmented--files">{tab(FILES_VIEW)}</div>
      <div className="segmented">
        {FILE_VIEWS.map((v) => tab(v, !enabled.includes(v.id)))}
      </div>
      <div className="segmented segmented--instrument">{tab(INSTRUMENT_VIEW)}</div>
    </div>
  );
}
