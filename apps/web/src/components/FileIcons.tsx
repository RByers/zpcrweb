/**
 * The glyph on a file chip, saying **what the file is**: a run, a plate map, a thermal protocol,
 * or a run report. Not what it is encoded as — a `.pltd` and a `.plt.csv` are both a plate and get
 * the same icon, which is the point: the file bar shows the seven accepted formats as the four
 * kinds of thing they actually are. The mapping is the library's ({@link fileCategory}), not this
 * file's.
 *
 * Colour is not part of the shape: the icon draws in `currentColor`, and `FileBar` sets that from
 * the chip's *encryption* status — the meaning the dot these replaced used to carry alone. Shape
 * answers "what", colour answers "can I open it".
 *
 * Same drawing conventions as `ViewIcons.tsx` — 16×16 viewBox, `currentColor` strokes,
 * `aria-hidden` (the chip's text label carries the name) — but drawn a little heavier and with
 * fewer marks, because these render at 13px in a crowded chip rather than at 14px on a tab.
 */
import { fileCategory, type FileKind } from "@zpcrweb/core";

function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** A run (`.zpcr`, `.pcrd`, Biomeme `.bmrun`): an amplification sigmoid on its axes — the thing a
 * run uniquely has, since the other two kinds describe a run that hasn't happened yet. */
export function RunFileIcon() {
  return (
    <Svg>
      <path d="M2.5 2v11.5H14" />
      <path d="M4.2 11.8c3 0 3.2-7.2 5-7.2s2 2.8 4.5 3" />
    </Svg>
  );
}

/** A plate map (`.pltd`, `.plt.csv`): the well grid, two rows of three inside the plate outline.
 * The wells are filled rather than drawn as rings — at 13px a 1.3px ring closes up into a blob,
 * and six blobs in a box stop reading as a grid at all. */
export function PlateFileIcon() {
  return (
    <Svg>
      <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="1.5" />
      <g fill="currentColor" stroke="none">
        <circle cx="5" cy="6.4" r="0.85" />
        <circle cx="8" cy="6.4" r="0.85" />
        <circle cx="11" cy="6.4" r="0.85" />
        <circle cx="5" cy="9.6" r="0.85" />
        <circle cx="8" cy="9.6" r="0.85" />
        <circle cx="11" cy="9.6" r="0.85" />
      </g>
    </Svg>
  );
}

/** A thermal protocol (`.prcl`, `.prcl.txt`): the temperature profile as a step trace — denature
 * high, anneal low, extend, and back round again. */
export function ProtocolFileIcon() {
  return (
    <Svg>
      <path d="M1.8 11.5h2.4V4h3v5.2h3V6.4h3.2" />
    </Svg>
  );
}

/** A run report (`.alf`): a page with ruled lines, since that is what it is — the instrument's
 * written account of a run rather than any of the run's data. */
export function ReportFileIcon() {
  return (
    <Svg>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M5.5 7.5h5M5.5 10h5M5.5 12.5h3" />
    </Svg>
  );
}

/**
 * A file the app is holding but currently cannot read — an exclamation in a circle, drawn where
 * the kind icon would be. It replaces the kind icon rather than sitting beside it because the kind
 * is a guess at that point: it came from the file's name, not from bytes anyone has read.
 *
 * Drawn in `currentColor` like the rest, and the Files table sets that to the app's danger red.
 */
export function FileErrorIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6v4.2" />
      <circle cx="8" cy="11.4" r="0.75" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** The icon for a loaded file, chosen by what the file is rather than how it is encoded. */
export function FileKindIcon({ kind }: { kind: FileKind }) {
  switch (fileCategory(kind)) {
    case "plate":
      return <PlateFileIcon />;
    case "protocol":
      return <ProtocolFileIcon />;
    case "report":
      return <ReportFileIcon />;
    default:
      return <RunFileIcon />;
  }
}
