import type { PlateDefinition } from "@zpcrweb/core";
import { PasswordPrompt } from "../PasswordPrompt";
import { PlateEditor } from "../plate/PlateEditor";
import { PlateDownloadButton } from "../plate/PlateDownloadButton";
import { usePltdPassword } from "../../state/pltdPassword";
import { fileBytes, type LoadedFile, type PlateFileResult } from "../../state/useZpcrStore";

/** The "Plate" tab for a standalone `.pltd`/`.plt.csv` top-level entry (not attached to any
 * run) — the same {@link PlateViewer} grid the "Plates" tab of a `.zpcr`/`.pcrd` run uses, just
 * resolved from {@link PlateFileResult} instead of `Zpcr.plates()`, and wrapped in
 * {@link PlateEditor} so a `.plt.csv` can be edited in place (`onChangePlate`; a `.pltd` has no
 * writer, so it gets the same grid with no pencil). */
export function StandalonePlateView({
  file,
  result,
  onChangePlate,
}: {
  file: LoadedFile;
  result: PlateFileResult;
  /** Persist an edited plate — only for a `.plt.csv`, which is the only plate encoding this app
   * can write. See the store's `setPlateText`. */
  onChangePlate?: (plate: PlateDefinition) => void;
}) {
  const [, setPassword] = usePltdPassword();
  const pltd = file.kind === "pltd" ? { name: file.name, bytes: fileBytes(file) } : undefined;
  // Rides the plate's heading line when there is one to share; the password/error branches
  // below have no heading, so they keep it above their own content.
  const toolbar = <PlateDownloadButton plate={result.plate ?? undefined} pltd={pltd} />;
  const showsViewer = !result.needsPassword && !result.error && !!result.plate;

  return (
    <div className="plateview">
      <section className="plateview__main">
        {showsViewer ? null : <div className="plateview__toolbar">{toolbar}</div>}
        {result.needsPassword || result.error ? (
          <div className="decoded">
            <PasswordPrompt wrong={!!result.error} onSubmit={setPassword} />
          </div>
        ) : !result.plate ? (
          <div className="decoded__na mono">No plate decoded.</div>
        ) : (
          <PlateEditor
            plate={result.plate}
            kind={file.kind}
            sourceHint={file.name}
            tools={toolbar}
            onChange={onChangePlate}
          />
        )}
      </section>
    </div>
  );
}
