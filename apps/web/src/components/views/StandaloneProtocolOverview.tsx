import { Fragment, useEffect, useState } from "react";
import { fileKindDescription } from "@zpcrweb/core";
import { RenameIcon } from "../RenameIcon";
import { formatCompactDateTime } from "../../lib/experiment";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.prcl.txt` — just the same `Type`/`Filename`/
 * `Last modified` info-table rows every other kind's Overview leads with, plus the rename
 * control. Everything about the protocol itself — lid/volume, the step list, the annotated
 * directive listing — lives on the "Protocol" tab (`StandaloneProtocolView`), so this stays a
 * minimal identity card rather than duplicating that detail.
 */
export function StandaloneProtocolOverview({
  file,
  onRenameFile,
}: {
  file: LoadedFile;
  /** Rename the loaded file (`ZpcrStore.renameFile`) — a `.prcl.txt` has no separate "name" the
   * way a `.zpcr` does, so this is the only identity it has to edit. */
  onRenameFile: (name: string) => void;
}) {
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
    </div>
  );
}
