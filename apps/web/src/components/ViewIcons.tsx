/** Line icons for the header controls — the view tabs (see `ViewSelector`) and the compact
 * DropZone. They carry the whole meaning on a narrow viewport, where `app.css` hides the word
 * labels and leaves only these; on a wide one they sit beside the label.
 *
 * Same drawing conventions as {@link DownloadIcon}: a 16×16 viewBox, `currentColor` strokes at
 * 1.1px, `aria-hidden` (every icon has a text label or `aria-label` next to it). Keep new icons
 * in that grid so the strip stays optically even. */

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      className="icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Overview: a summary panel — header bar plus lines of detail. */
export function OverviewIcon() {
  return (
    <Svg>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M5 9h6M5 11.2h4" />
    </Svg>
  );
}

/** Curves: an amplification sigmoid rising off the baseline, on a pair of axes. */
export function CurvesIcon() {
  return (
    <Svg>
      <path d="M2.5 2v11.5H14" />
      <path d="M4 12c3.2 0 3.4-7 5-7s2 3.2 4.5 3.4" />
    </Svg>
  );
}

/** Calibration: a pure-dye response rising with temperature, sampled at four measured points. */
export function CalibrationIcon() {
  return (
    <Svg>
      <path d="M2.5 2v11.5H14" />
      <path d="M4.5 11.5 7 9l2.5 1.2L13 4.5" />
      <circle cx="4.5" cy="11.5" r="0.9" />
      <circle cx="9.5" cy="10.7" r="0.9" />
      <circle cx="13" cy="4.5" r="0.9" />
    </Svg>
  );
}

/** Plates: the well grid of a plate map. */
export function PlatesIcon() {
  return (
    <Svg>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.2" cy="6.2" r="1.05" />
      <circle cx="8" cy="6.2" r="1.05" />
      <circle cx="10.8" cy="6.2" r="1.05" />
      <circle cx="5.2" cy="9.8" r="1.05" />
      <circle cx="8" cy="9.8" r="1.05" />
      <circle cx="10.8" cy="9.8" r="1.05" />
    </Svg>
  );
}

/** Reference: a calibration crosshair — the fixed point everything else is measured against. */
export function ReferenceIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="4.2" />
      <circle cx="8" cy="8" r="1.1" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" />
    </Svg>
  );
}

/** Raw files: a document with a folded corner. */
export function RawIcon() {
  return (
    <Svg>
      <path d="M9.5 2H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V4.5z" />
      <path d="M9.5 2v2.5H12" />
      <path d="M6 8.5h4M6 11h2.5" />
    </Svg>
  );
}

/** Load file: an arrow rising out of an open tray. */
export function UploadIcon() {
  return (
    <Svg>
      <path d="M8 10.5V2.5m0 0L5.2 5.3M8 2.5l2.8 2.8" />
      <path d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
    </Svg>
  );
}
