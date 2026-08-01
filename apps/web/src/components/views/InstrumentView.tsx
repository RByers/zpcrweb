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
import { useMemo, useState } from "react";
import { planRun } from "@zpcrweb/core";
import { InstrumentRail } from "../instrument/InstrumentRail";
import { InstrumentRun } from "../instrument/InstrumentRun";
import { InstrumentFiles } from "../instrument/InstrumentFiles";
import { InstrumentConsole } from "../instrument/InstrumentConsole";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";
import type { StagedRun } from "../../lib/protocolSource";

export function InstrumentView({
  onOpenRun,
  staged,
  instrument,
  runWatch,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The run the file bar's selection currently describes; see {@link InstrumentRun}. */
  staged: StagedRun;
  /** The connection, owned by `App` so it outlives this view — see its comment there. */
  instrument: CfxDeviceHandle;
  /** The follow-the-running-run machinery, likewise owned by `App`. */
  runWatch: RunWatchState;
}) {
  // The name for the run being staged. Held here rather than in `InstrumentRun` so it survives that
  // panel's re-renders, and because it is an input to the plan below — it is part of the staged
  // run, not of the panel that displays it.
  const [experimentName, setExperimentName] = useState("");

  /**
   * The staged run reduced to exactly what would be sent — commands, files, and the checks that
   * decide whether it may be sent at all (`usb/runPlan.ts`).
   *
   * Computed here, above both the panel that displays it and the rail that sends it, so the two
   * cannot disagree: the warnings shown next to the plate are the same object the Start button
   * consults. Null when a half is missing, which is simply "not a run yet".
   */
  const plan = useMemo(() => {
    const protocol = staged.protocol.value;
    const plate = staged.plate.value;
    if (!protocol || !plate) return null;
    try {
      return planRun({
        runDefinition: protocol.runDefinition,
        plate,
        name: experimentName || protocol.document.name || "",
      });
    } catch {
      // A run definition this app can't parse can't be planned; the panel already renders the
      // protocol's own decode, so there is nothing useful to add here.
      return null;
    }
  }, [staged.protocol.value, staged.plate.value, experimentName]);

  return (
    <div className="curves instrument">
      <InstrumentRail
        instrument={instrument}
        staged={staged}
        plan={plan}
        runWatch={runWatch}
      />
      <div className="instrument__content">
        <InstrumentRun
          staged={staged}
          name={experimentName}
          onNameChange={setExperimentName}
          plan={plan}
        />
        <InstrumentFiles instrument={instrument} onOpenRun={onOpenRun} />
        <InstrumentConsole instrument={instrument} />
      </div>
    </div>
  );
}
