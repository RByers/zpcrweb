/**
 * The **view bar** — the app's tab strip, and the counterpart of the **file bar** below it
 * (`FileBar.tsx`). Those two names are how the rest of the codebase and its docs refer to these
 * surfaces; see `apps/web/ARCHITECTURE.md`, "Files, loaded files, and the one selection".
 *
 * It has exactly two groups, and the split says what each is a lens on:
 *
 * - **Files** — the catalog, every file the browser holds (`FilesTableView.tsx`). Not tied to the
 *   selection, so it is the one tab that is *always* enabled: with nothing selected it is where
 *   you go to select something.
 * - **the file views** — Overview through Instrument. Every one of these is a lens on the **one
 *   selected file**, so the whole group is disabled when nothing is selected, and individual tabs
 *   are disabled when they don't apply to the file that is (`App.tsx`'s `enabledViewsFor`).
 *
 * Instrument is in that second group like any other. It used to sit apart, on the argument that a
 * cycler is not a file — but what it actually does is start *the selected experiment* and follow
 * the run that comes out of it, which makes it exactly as file-backed as Protocol is. Keeping it
 * outside meant the strip had a tab whose meaning didn't move with the selection, which is the one
 * thing this bar must never have.
 *
 * **The strip is the same eight tabs whatever the selection is.** A tab that doesn't apply is
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
  { id: "instrument", label: "Instrument", Icon: InstrumentIcon },
];

/** The catalog tab, in its own group and always enabled — see the module comment. */
const FILES_VIEW: Tab = { id: "files", label: "Files", Icon: FilesIcon };

interface Props {
  value: ViewId;
  onChange: (v: ViewId) => void;
  /**
   * Which file views the selected file supports, e.g. `["overview", "plates", "raw"]` for a
   * standalone `.pltd`/`.plt.csv`. An **empty** array is the no-selection case: nothing applies,
   * so every file view greys out and only Files remains.
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
    </div>
  );
}
