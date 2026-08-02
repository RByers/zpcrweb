import { PasswordPrompt } from "../PasswordPrompt";
import { OverviewPanel, type InfoRow, type OverviewPanelProps } from "./OverviewPanel";
import { OverviewPlateSection } from "./OverviewPlateSection";
import { usePltdPassword } from "../../state/pltdPassword";
import type { LoadedFile, PlateFileResult } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.pltd`/`.plt.csv` — a plate with no run around it.
 *
 * The shared {@link OverviewPanel} plus what a bare plate adds to it: three rows of the plate
 * setup's own facts, and below the table its target/sample chips (the same
 * {@link OverviewPlateSection} a run shows, with no Cq table to tally against) or, when the file
 * is still locked, the password prompt.
 */
export function StandalonePlateOverviewView({
  file,
  result,
  ...tools
}: {
  file: LoadedFile;
  result: PlateFileResult;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "onClone" | "autoEditName" | "onAutoEditHandled"
>) {
  const [, setPassword] = usePltdPassword();
  const plate = result.plate;

  const rows: InfoRow[] = plate
    ? [
        { label: "Plate", value: `${plate.rows}×${plate.columns}` },
        { label: "Vessel", value: plate.plateName || "—" },
        ...(result.container
          ? [{ label: "Encrypted", value: result.container.encrypted ? "Yes" : "No" }]
          : []),
      ]
    : [];

  return (
    <OverviewPanel
      file={file}
      rows={rows}
      downloadTitle="Download this plate file as it was loaded"
      {...tools}
    >
      {(result.needsPassword || result.error) && (
        <div className="decoded">
          <PasswordPrompt wrong={!!result.error} onSubmit={setPassword} />
        </div>
      )}
      {!result.needsPassword && !result.error && !plate && (
        <div className="decoded__na mono">No plate decoded.</div>
      )}
      <OverviewPlateSection plate={plate} />
    </OverviewPanel>
  );
}
