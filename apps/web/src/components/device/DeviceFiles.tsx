/**
 * Browse and retrieve the instrument's own filesystem.
 *
 * A retrieved file is saved to disk rather than loaded into the app: what lives on the instrument
 * are the *parts* of a run — individual `.Plateread`s, the `.Dcal` set, `RunInfo.xml`, the
 * `.pltd`/`.prcl` pair — where every format this app opens is a whole run in one container. Saving
 * them is the honest operation; assembling a `.zpcr` out of them is a separate job (see the note
 * in `apps/web/ARCHITECTURE.md`).
 */
import { CFX_DIRECTORIES } from "@zpcrweb/core";
import { downloadBytes } from "../../lib/download";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

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

export function DeviceFiles({ device }: { device: CfxDeviceHandle }) {
  const { directories, busy, connection } = device;
  const connected = connection === "connected";

  const retrieve = async (dir: string, name: string) => {
    const bytes = await device.fetchFile(dir, name);
    if (bytes) downloadBytes(name, bytes);
  };

  return (
    <section className="device__panel">
      <div className="device__panelhead">
        <h2 className="device__paneltitle">Files on the instrument</h2>
        <button className="btn btn--sm" disabled={!connected || !!busy} onClick={() => void device.refreshAll()}>
          Refresh all
        </button>
      </div>

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
            return (
              <div key={d.path} className="device__dir">
                <div className="device__dirhead">
                  <div>
                    <span className="device__dirname">{d.label}</span>
                    <span className="device__dirpath mono">{d.path}</span>
                  </div>
                  <button
                    className="btn btn--sm"
                    disabled={!!busy}
                    onClick={() => void device.refreshDirectory(d.path)}
                  >
                    {dir ? "Reload" : "List"}
                  </button>
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
    </section>
  );
}
