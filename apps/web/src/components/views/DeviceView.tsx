/**
 * The Device view — a live CFX96 over WebUSB, rather than a file.
 *
 * Unlike every other view it is not a lens on the active file — but it is not file-independent
 * either: starting a run needs a protocol and a plate, and those come from the app's loaded files
 * (`state/useRunStaging.ts`). So the file bar stays, with a different meaning: a chip is part of
 * the run being staged rather than the thing you are looking at.
 *
 * Layout reuses the Curves view's rail + content grid so it reads as the same kind of surface:
 * the rail carries connection, identity, status and the commands that actuate the instrument
 * (including Start run), and the content column stacks the staged run, the file browser and the
 * traffic console.
 */
import { useState } from "react";
import { DeviceRail } from "../device/DeviceRail";
import { DeviceRun } from "../device/DeviceRun";
import { DeviceFiles } from "../device/DeviceFiles";
import { DeviceConsole } from "../device/DeviceConsole";
import { useCfxDevice } from "../../state/useCfxDevice";
import type { StagedRun } from "../../lib/protocolSource";

export function DeviceView({
  onOpenRun,
  staged,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The run the file bar's selection currently describes; see {@link DeviceRun}. */
  staged: StagedRun;
}) {
  const device = useCfxDevice();
  // The name for the run being staged. Held here rather than in `DeviceRun` so it survives that
  // panel's re-renders and is reachable by the rail's Start run once there is one to send
  // (`usb.md` §10) — it is part of the staged run, not of the panel that displays it.
  const [experimentName, setExperimentName] = useState("");
  return (
    <div className="curves device">
      <DeviceRail device={device} staged={staged} />
      <div className="device__content">
        <DeviceRun staged={staged} name={experimentName} onNameChange={setExperimentName} />
        <DeviceFiles device={device} onOpenRun={onOpenRun} />
        <DeviceConsole device={device} />
      </div>
    </div>
  );
}
