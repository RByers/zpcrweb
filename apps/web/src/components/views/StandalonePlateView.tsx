import { PasswordPrompt } from "../PasswordPrompt";
import { PlateViewer } from "../plate/PlateViewer";
import { PlateDownloadButton } from "../plate/PlateDownloadButton";
import { usePltdPassword } from "../../state/pltdPassword";
import type { LoadedFile, PlateFileResult } from "../../state/useZpcrStore";

/** The "Plate" tab for a standalone `.pltd`/`.plt.csv` top-level entry (not attached to any
 * run) — same {@link PlateViewer} the "Plates" tab of a `.zpcr`/`.pcrd` run uses, just resolved
 * from {@link PlateFileResult} instead of `Zpcr.plates()`. */
export function StandalonePlateView({ file, result }: { file: LoadedFile; result: PlateFileResult }) {
  const [, setPassword] = usePltdPassword();
  const pltd = file.kind === "pltd" ? { name: file.name, bytes: file.bytes } : undefined;

  return (
    <div className="plateview">
      <section className="plateview__main">
        <div className="plateview__toolbar">
          <PlateDownloadButton plate={result.plate ?? undefined} pltd={pltd} />
        </div>
        {result.needsPassword || result.error ? (
          <div className="decoded">
            <PasswordPrompt wrong={!!result.error} onSubmit={setPassword} />
          </div>
        ) : !result.plate ? (
          <div className="decoded__na mono">No plate decoded.</div>
        ) : (
          <PlateViewer plate={result.plate} sourceHint={file.name} />
        )}
      </section>
    </div>
  );
}
