/**
 * The Instrument view — a live CFX96 over WebUSB, rather than a file.
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
import { InstrumentRail } from "../instrument/InstrumentRail";
import { InstrumentRun } from "../instrument/InstrumentRun";
import { InstrumentFiles } from "../instrument/InstrumentFiles";
import { InstrumentConsole } from "../instrument/InstrumentConsole";
import { useCfxDevice } from "../../state/useCfxDevice";
import type { StagedRun } from "../../lib/protocolSource";

export function InstrumentView({
  onOpenRun,
  staged,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The run the file bar's selection currently describes; see {@link InstrumentRun}. */
  staged: StagedRun;
}) {
  const instrument = useCfxDevice();
  // The name for the run being staged. Held here rather than in `InstrumentRun` so it survives that
  // panel's re-renders and is reachable by the rail's Start run once there is one to send
  // (`usb.md` §10) — it is part of the staged run, not of the panel that displays it.
  const [experimentName, setExperimentName] = useState("");
  return (
    <div className="curves instrument">
      <InstrumentRail instrument={instrument} staged={staged} />
      <div className="instrument__content">
        <InstrumentRun staged={staged} name={experimentName} onNameChange={setExperimentName} />
        <InstrumentFiles instrument={instrument} onOpenRun={onOpenRun} />
        <InstrumentConsole instrument={instrument} />
      </div>
    </div>
  );
}
