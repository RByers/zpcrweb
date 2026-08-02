import { Fragment, useMemo } from "react";
import { fileKindDescription, plateTargets } from "@zpcrweb/core";
import { PasswordPrompt } from "../PasswordPrompt";
import { OverviewToolbar, useFilenameEditor } from "../OverviewFileTools";
import { usePltdPassword } from "../../state/pltdPassword";
import { channelColor } from "../../lib/channelColors";
import { formatCompactDateTime } from "../../lib/experiment";
import type { LoadedFile, PlateFileResult } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.pltd`/`.plt.csv` — a plate with no run around it. Every
 * other file kind has an Overview of its own (a run's own {@link OverviewView}, or the protocol
 * equivalent); this is the plate one, cut down to what a bare plate actually carries: no run to
 * date, no Cq table to tally against its target/sample chips (see `OverviewView.chipCounts`) —
 * just what the file and the plate setup itself say.
 */
export function StandalonePlateOverviewView({
  file,
  result,
  onRenameFile,
  onDownload,
  onClone,
  autoEditName,
  onAutoEditHandled,
}: {
  file: LoadedFile;
  result: PlateFileResult;
  /** Rename the loaded file (`ZpcrStore.renameFile`) — a standalone plate has no separate "name"
   * the way a `.zpcr` does, so this is the only identity it has to edit. */
  onRenameFile: (name: string) => void;
  /** Save the plate file itself to disk — the `.pltd`/`.plt.csv` bytes as loaded. (The Plates
   * tab's own download button converts *between* the two forms; this one is the file.) */
  onDownload: () => void;
  onClone: () => void;
  autoEditName?: boolean;
  onAutoEditHandled?: () => void;
}) {
  const [, setPassword] = usePltdPassword();
  const plate = result.plate;
  const targets = useMemo(() => (plate ? plateTargets(plate) : []), [plate]);
  const samples = plate?.samples ?? [];

  const filename = useFilenameEditor({
    name: file.name,
    onRename: onRenameFile,
    autoEdit: autoEditName,
    onAutoEditHandled,
  });

  const infoRows = [
    { label: "Type", value: fileKindDescription(file.kind) },
    { label: "Filename", value: filename.field },
    { label: "Last modified", value: formatCompactDateTime(new Date(file.lastModified)) },
    ...(plate
      ? [
          { label: "Plate", value: `${plate.rows}×${plate.columns}` },
          { label: "Vessel", value: plate.plateName || "—" },
          ...(result.container
            ? [{ label: "Encrypted", value: result.container.encrypted ? "Yes" : "No" }]
            : []),
        ]
      : []),
  ];

  return (
    <div className="overview">
      <div className="overview__head">
        <dl className="overview__dl overview__infotable mono">
          {infoRows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
        <OverviewToolbar
          name={file.name}
          onDownload={onDownload}
          onEdit={filename.beginEdit}
          onClone={onClone}
        />
      </div>

      {(result.needsPassword || result.error) && (
        <div className="decoded">
          <PasswordPrompt wrong={!!result.error} onSubmit={setPassword} />
        </div>
      )}

      {!result.needsPassword && !result.error && !plate && (
        <div className="decoded__na mono">No plate decoded.</div>
      )}

      {plate && (targets.length > 0 || samples.length > 0) && (
        <section className="overview__block">
          <h2 className="overview__h">Plate{plate.identityKey ? `: ${plate.identityKey}` : ""}</h2>
          <div className="overview__platelists">
            {targets.length > 0 && (
              <div className="overview__platelist">
                <div className="overview__platelist-h">Targets</div>
                <div className="filecard__chips">
                  {targets.map((t) => (
                    <span
                      key={t.name}
                      className="filecard__chip"
                      style={t.channel != null ? { color: channelColor(t.channel) } : undefined}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {samples.length > 0 && (
              <div className="overview__platelist">
                <div className="overview__platelist-h">Samples</div>
                <div className="filecard__chips">
                  {samples.map((s) => (
                    <span key={s} className="filecard__chip">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
