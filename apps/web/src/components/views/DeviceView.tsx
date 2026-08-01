/**
 * The Device view — a live CFX96 over WebUSB, rather than a file.
 *
 * It is the one view that operates on no `LoadedFile` at all, which is why `App` hides the file
 * bar while it is showing and why its tab sits apart from the others (see `ViewSelector`). Layout
 * reuses the Curves view's rail + content grid so it reads as the same kind of surface: the rail
 * carries connection, identity, status and actions, and the content column stacks the file
 * browser above the traffic console.
 */
import { DeviceRail } from "../device/DeviceRail";
import { DeviceFiles } from "../device/DeviceFiles";
import { DeviceProtocol } from "../device/DeviceProtocol";
import { DeviceConsole } from "../device/DeviceConsole";
import { useCfxDevice } from "../../state/useCfxDevice";
import type { LoadedFile, PlateFileResult, RunResult } from "../../state/useZpcrStore";

export function DeviceView({
  onOpenRun,
  files,
  runs,
  plateFiles,
  activeId,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The app's loaded files, for {@link DeviceProtocol}'s picker. This view shows no file of its
   * own — these are candidate *protocols* to send, not something to view. */
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  activeId: string | null;
}) {
  const device = useCfxDevice();
  return (
    <div className="curves device">
      <DeviceRail device={device} />
      <div className="device__content">
        <DeviceProtocol
          device={device}
          files={files}
          runs={runs}
          plateFiles={plateFiles}
          activeId={activeId}
        />
        <DeviceFiles device={device} onOpenRun={onOpenRun} />
        <DeviceConsole device={device} />
      </div>
    </div>
  );
}
