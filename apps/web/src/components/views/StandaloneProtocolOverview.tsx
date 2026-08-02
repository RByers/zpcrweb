import { OverviewPanel, type OverviewPanelProps } from "./OverviewPanel";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a standalone `.prcl.txt`.
 *
 * The bare {@link OverviewPanel} and nothing else: a protocol file has no rows, header, banner or
 * sections of its own to add, so the shared `Type`/`Filename`/`Last modified` card plus the file
 * toolbar *is* its Overview. Everything about the protocol itself — lid/volume, the step list,
 * the annotated directive listing — lives on the "Protocol" tab (`StandaloneProtocolView`).
 */
export function StandaloneProtocolOverview({
  file,
  ...tools
}: {
  file: LoadedFile;
} & Pick<
  OverviewPanelProps,
  "onRenameFile" | "onDownload" | "onClone" | "autoEditName" | "onAutoEditHandled"
>) {
  return <OverviewPanel file={file} {...tools} />;
}
