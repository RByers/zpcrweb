/**
 * Browse and retrieve the instrument's own filesystem.
 *
 * A single retrieved file is saved to disk rather than loaded into the app: what lives on the
 * instrument are the *parts* of a run — individual `.Plateread`s, the `.Dcal` set, `RunInfo.xml`,
 * the `.pltd`/`.prcl` pair — where every format this app opens is a whole run in one container.
 *
 * A whole directory is a different matter, and is what **Open run** does: a `.zpcr` *is* a ZIP of
 * a run directory, so pulling every file and zipping them (`zpcrFromRunFiles`) yields a real
 * `.zpcr` — not a reconstruction — which then goes through exactly the same validate/persist path
 * as a dropped file. The button is offered for any directory whose listing has a `RunInfo.xml`,
 * which is what makes it a run rather than an arbitrary folder.
 */
import { useState } from "react";
import { CFX_DIRECTORIES, zpcrFromRunFiles } from "@zpcrweb/core";
import { downloadBytes } from "../../lib/download";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

/** The file that makes a directory a run — and the one `parseZpcr` refuses an archive without. */
const RUNINFO_NAME = "RunInfo.xml";

/** Group a flat listing the way the Raw view groups a `.zpcr`'s entries, so a 42-entry
 * `CurrentRun` reads as a handful of kinds rather than one long alphabetical wall. */
function groupOf(name: string): string {
  if (/\.Plateread$/i.test(name)) return "Plate reads";
  if (/\.Dcal$/i.test(name)) return "Calibration";
  if (/\.(pltd|prcl)$/i.test(name)) return "Plate & protocol";
  if (/\.(xml|txt)$/i.test(name)) return "Metadata";
  if (/\.alf$/i.test(name)) return "Run report";
  return "Other";
}

const GROUP_ORDER = [
  "Metadata",
  "Plate & protocol",
  "Plate reads",
  "Run report",
  "Calibration",
  "Other",
];

export function DeviceFiles({
  device,
  onOpenRun,
}: {
  device: CfxDeviceHandle;
  /** Hand the assembled `.zpcr` to the app, exactly as if it had been dropped on the drop zone. */
  onOpenRun: (file: File) => Promise<void> | void;
}) {
  const { directories, busy, connection } = device;
  const connected = connection === "connected";
  const [openError, setOpenError] = useState<string | null>(null);

  const retrieve = async (dir: string, name: string) => {
    const bytes = await device.fetchFile(dir, name);
    if (bytes) downloadBytes(name, bytes);
  };

  const openRun = async (dir: string, names: string[]) => {
    setOpenError(null);
    const files = await device.fetchDirectoryFiles(dir, names);
    // `undefined` means the fetch itself failed, which the rail already reports.
    if (!files) return;
    try {
      const { name, bytes } = zpcrFromRunFiles(files);
      // `.slice()` for the same reason `downloadBytes` does it: a `Uint8Array` over a possibly
      // shared buffer isn't a `BlobPart`, and a copy of a few hundred KB costs nothing here.
      await onOpenRun(new File([bytes.slice()], name));
    } catch (e) {
      setOpenError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    // Collapsed by default: browsing the instrument's storage is a deliberate act, and a listed
    // `CurrentRun` is long enough to bury the protocol panel above it when it isn't wanted.
    <details className="device__panel device__panel--collapsible">
      <summary className="device__panelhead">
        <h2 className="device__paneltitle">
          <span className="rail__chevron" aria-hidden="true">
            ▸
          </span>
          Files on the instrument
        </h2>
        <button
          className="btn btn--sm"
          disabled={!connected || !!busy}
          // No toggle guard needed: a <button> inside a <summary> is its own activation target,
          // so clicking it never folds the panel.
          onClick={() => void device.refreshAll()}
        >
          Refresh all
        </button>
      </summary>

      {openError && <div className="rail__note">Couldn't open the run: {openError}</div>}

      {!connected ? (
        <div className="device__empty mono">Connect to browse the instrument's storage.</div>
      ) : (
        <div className="device__dirs">
          {CFX_DIRECTORIES.map((d) => {
            const dir = directories[d.path];
            const groups = new Map<string, string[]>();
            for (const name of dir?.names ?? []) {
              const g = groupOf(name);
              if (!groups.has(g)) groups.set(g, []);
              groups.get(g)!.push(name);
            }
            // Openable only when the listing actually holds a run: a directory of loose files
            // would zip into an archive `parseZpcr` rejects.
            const isRun = !!dir?.listed && dir.names.some((n) => n.toLowerCase() === RUNINFO_NAME.toLowerCase());
            return (
              <div key={d.path} className="device__dir">
                <div className="device__dirhead">
                  <div>
                    <span className="device__dirname">{d.label}</span>
                    <span className="device__dirpath mono">{d.path}</span>
                  </div>
                  <div className="device__dirbtns">
                    {isRun && (
                      <button
                        className="btn btn--sm btn--primary"
                        disabled={!!busy}
                        onClick={() => void openRun(d.path, dir!.names)}
                        title={`Retrieve all ${dir!.names.length} files and open them as one .zpcr`}
                      >
                        Open run
                      </button>
                    )}
                    <button
                      className="btn btn--sm"
                      disabled={!!busy}
                      onClick={() => void device.refreshDirectory(d.path)}
                    >
                      {dir ? "Reload" : "List"}
                    </button>
                  </div>
                </div>

                {!dir ? (
                  <div className="device__empty mono">Not listed yet.</div>
                ) : dir.status === "empty" ? (
                  // A real answer about this path, not a failure: listings cover files only, so a
                  // directory holding nothing but subdirectories reports itself empty.
                  <div className="device__empty mono">
                    No files here. Subdirectories aren't listed.
                  </div>
                ) : !dir.listed ? (
                  // Not a soft failure: without a length the instrument would replay whichever
                  // directory was listed last, so showing nothing is the only correct answer.
                  <div className="rail__note">
                    {dir.status === "missing"
                      ? "The instrument reports no such directory at this path."
                      : "This directory can't be listed: GETFILESLEN answered with a binary payload this app doesn't recognize."}{" "}
                    Nothing is shown because <code>LISTALLFILES</code> only ever returns the last
                    listing that succeeded — so any names here would belong to a different
                    directory.
                  </div>
                ) : dir.names.length === 0 ? (
                  <div className="device__empty mono">Empty.</div>
                ) : (
                  <>
                    <div className="device__dirmeta mono">
                      {dir.names.length} files · listing {dir.listingBytes} bytes
                    </div>
                    {GROUP_ORDER.filter((g) => groups.has(g)).map((g) => (
                      <div key={g} className="device__group">
                        <div className="device__grouptitle">{g}</div>
                        <ul className="device__files">
                          {groups.get(g)!.map((name) => (
                            <li key={name} className="device__file">
                              <span className="device__filename mono">{name}</span>
                              <button
                                className="btn btn--sm"
                                disabled={!!busy}
                                onClick={() => void retrieve(d.path, name)}
                              >
                                Retrieve
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </details>
  );
}
