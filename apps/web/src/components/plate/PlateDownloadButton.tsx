import { useRef } from "react";
import type { PlateDefinition } from "@zpcrweb/core";
import { plateToCsv } from "@zpcrweb/core";
import { downloadBytes, downloadText } from "../../lib/download";
import { DownloadIcon } from "../DownloadIcon";

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
}

/**
 * Two-option download menu for a decoded plate: the original `.pltd` bytes (when available) or
 * a `.plt.csv` re-serialized from the current {@link PlateDefinition}. Styled like the Raw
 * files view's single-format download button (`raw__download`), extended with a small
 * `<details>` menu since there are two choices here.
 */
export function PlateDownloadButton({ plate, pltd }: Props) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const canDownload = !!pltd || !!plate;
  if (!canDownload) return null;

  const csvName = `${sanitize(plate?.plateName || pltd?.name.replace(/\.(pltd|plt\.csv)$/i, "") || "plate")}.plt.csv`;

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details className="dlmenu" ref={detailsRef}>
      <summary className="raw__download" aria-label="Download plate">
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
  );
}
