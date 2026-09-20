/**
 * The React shell around core's {@link RunFollower} — keep a `.zpcr` of the run happening right
 * now in the app's file list.
 *
 * Every decision the follower makes is in the library now
 * (`packages/core/src/usb/runFollower.ts`), where the module comment explains them and where a
 * suite drives them against the emulator: the step-transition rule (`usb.md` §7.5), the §7.6
 * finish and its acknowledgement, the first-listing rule and its in-progress exception, and which
 * pass attaches the session's USB traffic log.
 *
 * What is left here is a `useSyncExternalStore` and one effect that feeds `observe` — plus the
 * store-facing callbacks `App.tsx` already passes, which are the follower's ports.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { RunFollower, type HeldRun, type RunFollowerState, type ZpcrArchive } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "./useCfxDevice";

export type { HeldRun } from "@zpcrweb/core";

/** The hook's handle: the follower's own state, plus the setters a view drives it with. */
export type RunWatchState = RunFollowerState & {
  setWatching: (on: boolean) => void;
  adopt: (fileName: string) => void;
  clearFinished: () => void;
  expectReportOnly: () => void;
  downloadAvailable: () => Promise<void>;
};

export function useRunWatch(
  instrument: CfxDeviceHandle,
  onRun: (
    run: { name: string; archive: ZpcrArchive; whole: boolean },
    previousId: string | null,
    activate: boolean,
  ) => Promise<string | null>,
  onReport: (name: string, bytes: Uint8Array) => Promise<string | null>,
  heldRun: (fileName: string) => HeldRun | null,
  /**
   * What the Instrument view's name fields currently hold. Read through a ref so a keystroke in
   * one does not restart anything.
   */
  naming?: { experimentName: string; fileName: string },
): RunWatchState {
  const { session, connection, status } = instrument;

  // The callbacks change identity on every App render — `heldRun` closes over the loaded files, so
  // it changes whenever any of them does, including on every pass this hook itself causes. The
  // follower must not be rebuilt for that, so it reads the latest through refs.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;
  const heldRunRef = useRef(heldRun);
  heldRunRef.current = heldRun;
  const namingRef = useRef(naming);
  namingRef.current = naming;

  const follower = useMemo(
    () =>
      new RunFollower(session, {
        heldRun: (name) => heldRunRef.current(name),
        onRun: (run, previousId, activate) => onRunRef.current(run, previousId, activate),
        onReport: (name, bytes) => onReportRef.current(name, bytes),
        naming: () => namingRef.current,
      }),
    [session],
  );

  const state = useSyncExternalStore(
    useCallback((fn) => follower.subscribe(fn), [follower]),
    () => follower.state,
  );

  // One observation per status the session publishes — and one on every connection change, so a
  // disconnect resets the follower's connection-scoped memory even while following is switched off.
  useEffect(() => {
    follower.observe(status, connection === "unsupported" ? "disconnected" : connection);
  }, [follower, status, connection]);

  return useMemo(
    () => ({
      ...state,
      setWatching: (on: boolean) => follower.setWatching(on),
      adopt: (id: string) => follower.adopt(id),
      clearFinished: () => follower.clearFinished(),
      expectReportOnly: () => follower.expectReportOnly(),
      downloadAvailable: () => follower.downloadAvailable(),
    }),
    [state, follower],
  );
}
