import { Fragment, useEffect, useMemo, useState } from "react";
import { fileKindDescription, plateTargets } from "@zpcrweb/core";
import { PasswordPrompt } from "../PasswordPrompt";
import { RenameIcon } from "../RenameIcon";
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
}: {
  file: LoadedFile;
  result: PlateFileResult;
  /** Rename the loaded file (`ZpcrStore.renameFile`) — a standalone plate has no separate "name"
   * the way a `.zpcr` does, so this is the only identity it has to edit. */
  onRenameFile: (name: string) => void;
}) {
  const [, setPassword] = usePltdPassword();
  const plate = result.plate;
  const targets = useMemo(() => (plate ? plateTargets(plate) : []), [plate]);
  const samples = plate?.samples ?? [];

  // Toggled by the toolbar's Rename button — turns the "Filename" info row into an editable
  // field, in place, the same commit-on-blur/Enter/Escape-reverts pattern `OverviewView` uses.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(file.name);
  useEffect(() => setDraft(file.name), [file.name]);
  const commit = () => {
    setRenaming(false);
    const next = draft.trim();
    if (!next || next === file.name) {
      setDraft(file.name);
      return;
    }
    onRenameFile(next);
  };

  const infoRows = [
    { label: "Type", value: fileKindDescription(file.kind) },
    {
      label: "Filename",
      value: renaming ? (
        <input
          className="overview__filename-input mono"
          value={draft}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(file.name);
              setRenaming(false);
            }
          }}
          aria-label="Filename"
          spellCheck={false}
        />
      ) : (
        file.name
      ),
    },
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
        <div className="overview__toolbar">
          <button
            className="raw__download overview__renamebtn"
            onClick={() => setRenaming(true)}
            aria-label={`Rename ${file.name}`}
            title="Rename this file"
          >
            <RenameIcon />
          </button>
        </div>
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
