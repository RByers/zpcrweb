import { Fragment } from "react";
import { fileKindDescription } from "@zpcrweb/core";
import { OverviewToolbar, useFilenameEditor } from "../OverviewFileTools";
import { formatCompactDateTime } from "../../lib/experiment";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.prcl.txt` — just the same `Type`/`Filename`/
 * `Last modified` info-table rows every other kind's Overview leads with, plus the shared file
 * toolbar. Everything about the protocol itself — lid/volume, the step list, the annotated
 * directive listing — lives on the "Protocol" tab (`StandaloneProtocolView`), so this stays a
 * minimal identity card rather than duplicating that detail.
 */
export function StandaloneProtocolOverview({
  file,
  onRenameFile,
  onDownload,
  onClone,
  autoEditName,
  onAutoEditHandled,
}: {
  file: LoadedFile;
  /** Rename the loaded file (`ZpcrStore.renameFile`) — a `.prcl.txt` has no separate "name" the
   * way a `.zpcr` does, so this is the only identity it has to edit. */
  onRenameFile: (name: string) => void;
  /** The file's bytes for the toolbar's Download button — the *edited* text when the Protocol
   * tab's editor has changed it, since the store keeps `LoadedFile.bytes` current. */
  onDownload: () => void;
  onClone: () => void;
  autoEditName?: boolean;
  onAutoEditHandled?: () => void;
}) {
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
    </div>
  );
}
