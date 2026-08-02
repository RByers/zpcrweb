/**
 * What the run about to be started is called, and what its file will be called — the two names
 * the Instrument view collects before anything is sent.
 *
 * They are separate because they answer different questions and only one of them has a channel to
 * the instrument. The **experiment name** is the run's identity: it goes out as `RemoteRun`'s name
 * operand (`usb.md` §7.3) and as the deposited `zpcrweb.json` (`usb/runPlan.ts`), which is what
 * makes the pulled archive state its own name. The **file name** is purely local — the name the
 * `.zpcr` this app assembles lands under (`state/useRunWatch.ts`) — and exists as its own field
 * because the instrument's composed name (`<date>_<time>_<serial>_<NAME>`, or `<date>_<NAME>`
 * from the touchscreen) is not something a user can influence, and was the reason a run named
 * here still arrived in the file bar named after its protocol.
 *
 * The file name **follows the experiment name until it is edited**: it is offered as
 * `<YYYYMMDD>-<name with spaces as underscores>` (core's `runFileBaseName`, which is also the
 * fallback a reloaded browser re-derives), and keeps tracking further edits to the name. Typing
 * in the file-name field stops that, because at that point the user has said something the
 * derivation cannot know. Clearing the field resumes it, which is also how to get back to the
 * offered name after an edit — there is no separate reset control to explain.
 *
 * Held above the view (in `App`) rather than inside it, because the run watcher needs the file
 * name too and outlives every view switch.
 */
import { useCallback, useMemo, useState } from "react";
import { runFileBaseName } from "@zpcrweb/core";

export interface RunNaming {
  /** What the run is called. Sent with it, and recorded in the archive. */
  experimentName: string;
  setExperimentName: (name: string) => void;
  /** The `.zpcr` base name, without extension. Local to this app; never sent. */
  fileName: string;
  setFileName: (name: string) => void;
  /** True once {@link fileName} has been typed over, i.e. it no longer follows the name. */
  fileNameOverridden: boolean;
}

interface Names {
  experimentName: string;
  fileName: string;
  overridden: boolean;
}

export function useRunNaming(): RunNaming {
  const [names, setNames] = useState<Names>({
    experimentName: "",
    fileName: "",
    overridden: false,
  });

  const setExperimentName = useCallback((experimentName: string) => {
    setNames((prev) => ({
      experimentName,
      fileName: prev.overridden ? prev.fileName : runFileBaseName(experimentName),
      overridden: prev.overridden,
    }));
  }, []);

  const setFileName = useCallback((fileName: string) => {
    setNames((prev) => ({
      ...prev,
      fileName,
      // An empty field, or one typed back to exactly what would have been offered, is not an
      // override — so clearing it hands the field back to the experiment name.
      overridden: fileName.trim() !== "" && fileName !== runFileBaseName(prev.experimentName),
    }));
  }, []);

  return useMemo(
    () => ({
      experimentName: names.experimentName,
      setExperimentName,
      fileName: names.fileName,
      setFileName,
      fileNameOverridden: names.overridden,
    }),
    [names, setExperimentName, setFileName],
  );
}
