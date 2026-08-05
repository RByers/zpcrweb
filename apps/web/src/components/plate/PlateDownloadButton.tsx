import { useRef } from "react";
import type { PlateDefinition } from "@zpcrweb/core";
import { plateToCsv } from "@zpcrweb/core";
import { downloadBytes, downloadText } from "../../lib/download";
import { stripPlateExt } from "../../lib/plateNames";
import { DownloadIcon } from "../DownloadIcon";
import { CloneIcon } from "../CloneIcon";

/** Sanitize a plate name / entry name into a safe file basename. */
function sanitize(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "plate";
}

interface Props {
  plate: PlateDefinition | undefined;
  /** Raw `.pltd` bytes + archive entry name, when the current plate is backed by a real
   * (non-CSV) `.pltd` file — enables the "Download .pltd" option. Absent for a `.plt.csv`-
   * sourced plate or a `.pcrd`'s embedded plate (no raw bytes exist for either). */
  pltd?: { name: string; bytes: Uint8Array };
  /** Extract this plate into an independent `.plt.csv` file, added to the app's own file list
   * (rather than saved to disk) — the "Clone" button. Same `plateToCsv` encode as "Download
   * .plt.csv"; the caller adds the resulting `File` via `addFiles`. Omitted (no Clone button)
   * where the plate is already its own file, e.g. `StandalonePlateView`. */
  onClone?: (file: File) => void;
}

/**
 * Two-option download menu for a decoded plate: the original `.pltd` bytes (when available) or
 * a `.plt.csv` re-serialized from the current {@link PlateDefinition}. Styled like the Raw
 * files view's single-format download button (`raw__download`), extended with a small
 * `<details>` menu since there are two choices here.
 */
export function PlateDownloadButton({ plate, pltd, onClone }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const canDownload = !!pltd || !!plate;
  if (!canDownload) return null;

  // identityKey (the plate setup's own identity) is the right user-facing name — plateName is
  // only a vessel/plastic type (see PlateDefinition.plateName's doc comment). identityKey and
  // the archive entry name are typically a source file name, hence stripPlateExt.
  const csvBaseName = plate?.identityKey || pltd?.name || plate?.plateName || "plate";
  const csvName = `${sanitize(stripPlateExt(csvBaseName))}.plt.csv`;

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <>
      <details className="dlmenu" ref={detailsRef}>
        <summary
          className="raw__download"
          aria-label="Download plate"
          title={
            "Download this plate — the original .pltd bytes when the run has them, or a .plt.csv " +
            "written from the plate as it stands here"
          }
        >
          <DownloadIcon />
        </summary>
        <div className="dlmenu__list">
          <button
            className="dlmenu__item mono"
            disabled={!pltd}
            title={pltd ? "" : "No .pltd bytes for this plate (it's a .plt.csv or an embedded .pcrd plate)"}
            onClick={() => {
              if (pltd) downloadBytes(pltd.name, pltd.bytes);
              close();
            }}
          >
            Download .pltd
          </button>
          <button
            className="dlmenu__item mono"
            disabled={!plate}
            onClick={() => {
              if (plate) downloadText(csvName, plateToCsv(plate), "text/csv");
              close();
            }}
          >
            Download .plt.csv
          </button>
        </div>
      </details>
      {onClone && (
        <button
          className="raw__download"
          disabled={!plate}
          onClick={() => {
            if (plate) onClone(new File([new TextEncoder().encode(plateToCsv(plate))], csvName));
          }}
          aria-label="Clone plate into an independent .plt.csv file"
          title="Extract this plate into its own .plt.csv file, kept alongside your other files"
        >
          <CloneIcon />
        </button>
      )}
    </>
  );
}
