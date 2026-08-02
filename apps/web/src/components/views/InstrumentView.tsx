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
import { useMemo } from "react";
import { planRun } from "@zpcrweb/core";
import { InstrumentRail } from "../instrument/InstrumentRail";
import { InstrumentRun } from "../instrument/InstrumentRun";
import { InstrumentFiles } from "../instrument/InstrumentFiles";
import { InstrumentConsole } from "../instrument/InstrumentConsole";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";
import type { RunWatchState } from "../../state/useRunWatch";
import type { RunNaming } from "../../state/useRunNaming";
import type { StagedRun } from "../../lib/protocolSource";

export function InstrumentView({
  onOpenRun,
  staged,
  instrument,
  runWatch,
  naming,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The run the file bar's selection currently describes; see {@link InstrumentRun}. */
  staged: StagedRun;
  /** The connection, owned by `App` so it outlives this view — see its comment there. */
  instrument: CfxDeviceHandle;
  /** The follow-the-running-run machinery, likewise owned by `App`. */
  runWatch: RunWatchState;
  /**
   * What the run being staged is called, and what its file will be called
   * (`state/useRunNaming.ts`). Owned by `App` for the same reason the two above are: the run
   * watcher reads it, and it must survive leaving this view.
   */
  naming: RunNaming;
}) {
  const { experimentName } = naming;

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
        // The deposited copies keep the protocol's and the plate's own names, not the run's
        // (`runPlan.ts`). An overridden half is named by the file it came from; an overridden
        // plate's file name beats the plate's `identityKey`, which records whatever `.pltd` it
        // was *saved* from and can be a stale name. A half supplied by the run passes nothing —
        // `staged.*.sourceName` is the run's own label there, which is exactly the name these
        // files must not take — and lets `planRun` fall back to what the plate says about itself.
        protocolName: protocol.document.name || undefined,
        plateName: (staged.plate.overridden && staged.plate.sourceName) || undefined,
      });
    } catch {
      // A run definition this app can't parse can't be planned; the panel already renders the
      // protocol's own decode, so there is nothing useful to add here.
      return null;
    }
  }, [
    staged.protocol.value,
    staged.plate.value,
    staged.plate.overridden,
    staged.plate.sourceName,
    experimentName,
  ]);

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
          naming={naming}
          plan={plan}
          status={instrument.status}
          pending={instrument.runPending}
        />
        <InstrumentFiles instrument={instrument} onOpenRun={onOpenRun} />
        <InstrumentConsole instrument={instrument} />
      </div>
    </div>
  );
}
