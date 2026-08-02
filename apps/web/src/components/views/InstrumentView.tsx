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
import { useCallback, useMemo, useRef } from "react";
import { planRun, runFileBaseName, zpcrSeedArchive } from "@zpcrweb/core";
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
  onRunSeeded,
  freeRunFileBase,
}: {
  onOpenRun: (file: File) => Promise<void> | void;
  /** The run the file bar's selection currently describes; see {@link InstrumentRun}. */
  staged: StagedRun;
  /** The connection, owned by `App` so it outlives this view — see its comment there. */
  instrument: CfxDeviceHandle;
  /** The follow-the-running-run machinery, likewise owned by `App`. */
  runWatch: RunWatchState;
  /**
   * What the run being staged is called (`state/useRunNaming.ts`). Owned by `App` for the same
   * reason the two above are: the run watcher reads it, and it must survive leaving this view.
   */
  naming: RunNaming;
  /** Take the `.zpcr` this view writes at the click on Start run into the app's file list
   * (`App`'s `seedRunFile`). */
  onRunSeeded: (file: File) => Promise<void> | void;
  /** The first base name at or after this one that no loaded file already has (`App`, over the
   * store's file list — i.e. over what is in IndexedDB). Consulted once, at the click. */
  freeRunFileBase: (base: string) => string;
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
        // The typed name and nothing else: a run inheriting its protocol's name would give every
        // run of that protocol the same one, and a blank name is an `error` check on the plan
        // (`usb/runPlan.ts`) rather than something to paper over here.
        name: experimentName,
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

  /**
   * Write the run's `.zpcr` at the moment it is started (`core/runSeed.ts`), from the plan that is
   * about to be sent plus the name that was typed.
   *
   * Built here, where the plan and the name both are, rather than in the rail that clicks the
   * button or in `App`, which knows nothing about staging. The plan supplies the plate and the
   * name deposit as the exact bytes going to the instrument, so the seed and the run folder agree
   * entry for entry.
   *
   * The file's name is settled here too, and only here: `<YYYYMMDD>-<experiment name>`, stepped
   * past any loaded file that already has it (`freeRunFileBase`), then **pinned** as the run's
   * (`naming.begin`) so every snapshot the watcher pulls supersedes this file instead of landing
   * beside it. Re-deriving it per snapshot would not do — the typed field clears when the run
   * ends, and the uniqueness step's answer changes the moment this very file is added.
   */
  const seedRunFile = useCallback(() => {
    const protocol = staged.protocol.value;
    if (!plan || !protocol || !experimentName.trim()) return;
    const fileBaseName = freeRunFileBase(runFileBaseName(experimentName));
    const { name, bytes } = zpcrSeedArchive({
      experimentName,
      fileBaseName,
      runDefinition: protocol.runDefinition,
      protocolName: protocol.document.name || undefined,
      plan,
    });
    naming.begin({ experimentName, fileName: fileBaseName });
    void onRunSeeded(new File([bytes.slice()], name, { lastModified: Date.now() }));
  }, [plan, staged.protocol.value, experimentName, naming.begin, freeRunFileBase, onRunSeeded]);

  /** The Experiment name field, so Start run can put the cursor in it when that is the one thing
   * missing — see `InstrumentRail`'s `promptForName`. */
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = useCallback(() => nameRef.current?.focus(), []);

  return (
    <div className="curves instrument">
      <InstrumentRail
        instrument={instrument}
        staged={staged}
        plan={plan}
        runWatch={runWatch}
        onStart={seedRunFile}
        onNeedName={focusName}
      />
      <div className="instrument__content">
        <InstrumentRun
          staged={staged}
          naming={naming}
          nameRef={nameRef}
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
