import { useMemo, useState } from "react";
import { isPltdName, type Zpcr } from "@zpcrweb/core";
import { PlateViewer } from "../plate/PlateViewer";
import { PlateDownloadButton } from "../plate/PlateDownloadButton";
import { PasswordPrompt } from "../PasswordPrompt";
import { DropZone } from "../DropZone";
import { usePltdPassword } from "../../state/pltdPassword";

/**
 * Visual plate viewer for every plate file attached to the run — one per `.pltd`/`.plt.csv`
 * archive entry (a `.zpcr`) or the single embedded `plateSetup2` (a `.pcrd`); {@link Zpcr.plates}
 * covers all three uniformly. A peer of "Curves", separate from "Raw files" (which shows plate
 * data as a table instead, see `raw/PlateTable.tsx`).
 *
 * Uses its own `.plateview` layout (flex, not `.raw`'s two-column grid) because the plate
 * list sidebar is conditional — a grid's fixed column tracks would misplace the lone
 * `.plateview__main` child when there's only one plate and no sidebar to fill the other track.
 */
export function PlatesView({
  zpcr,
  fileId,
  attachPlate,
}: {
  zpcr: Zpcr;
  fileId: string;
  attachPlate: (fileId: string, file: File) => Promise<void>;
}) {
  const [password, setPassword] = usePltdPassword();
  // Asked as a capability, not as a format: attaching a plate means writing an entry into the
  // run's archive, and downloading one means reading the `.pltd` bytes back out — both need an
  // archive to exist. A `.pcrd` has none (`EMPTY_ARCHIVE`), and so would any future format
  // without inner files. Phrasing it this way keeps the format-independence rule intact — see
  // `apps/web/ARCHITECTURE.md`, "Format independence".
  const hasArchive = zpcr.archive.entries.length > 0;
  const entries = useMemo(() => zpcr.plates(password || undefined), [zpcr, password]);
  const [selected, setSelected] = useState(0);

  const attachControl = (
    <DropZone
      onFiles={(files) => {
        const file = Array.from(files)[0];
        if (file) void attachPlate(fileId, file);
      }}
      accept=".pltd,.csv,.plt.csv"
      compactLabel={entries.length === 0 ? "attach plate" : "replace plate"}
      disabled={!hasArchive}
      disabledTitle="This run has no file archive to attach a plate to"
    />
  );

  if (entries.length === 0) {
    return (
      <div className="plateview plateview--empty">
        <div className="decoded__na mono">No plate files in this run.</div>
        {attachControl}
      </div>
    );
  }

  const entry = entries[Math.min(selected, entries.length - 1)]!;
  const { pltd } = entry;
  const pltdBytes =
    hasArchive && isPltdName(entry.name)
      ? { name: entry.name, bytes: zpcr.archive.bytes(entry.name) }
      : undefined;

  return (
    <div className="plateview">
      {entries.length > 1 && (
        <aside className="plateview__list raw__list">
          <div className="raw__group">
            <div className="raw__grouphead">Plates</div>
            {entries.map((e, i) => (
              <button
                key={e.name}
                className={"raw__item mono" + (i === selected ? " is-active" : "")}
                onClick={() => setSelected(i)}
                title={e.name}
              >
                {e.name}
              </button>
            ))}
          </div>
        </aside>
      )}

      <section className="plateview__main">
        <div className="plateview__toolbar">
          {attachControl}
          <PlateDownloadButton plate={pltd.plate} pltd={pltdBytes} />
        </div>
        {pltd.container.encrypted && (pltd.needsPassword || pltd.error) ? (
          <div className="decoded">
            <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
          </div>
        ) : pltd.error ? (
          <div className="decoded__na mono">{pltd.error}</div>
        ) : !pltd.plate ? (
          <div className="decoded__na mono">No plate for {entry.name}.</div>
        ) : (
          <PlateViewer plate={pltd.plate} sourceHint={entry.name} />
        )}
      </section>
    </div>
  );
}
