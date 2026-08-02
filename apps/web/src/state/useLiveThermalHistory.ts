/**
 * Buffers `STATUS?` polls into a block-temperature-over-time series for the run currently
 * underway — the live counterpart to `alfThermalProfile`'s after-the-fact reconstruction from a
 * finished run's `.alf` report (`lib/uplot/thermalChart.ts`). `useCfxDevice`'s poll loop only ever
 * exposes the latest `CfxStatus`, overwriting the previous one each tick, so nothing upstream of
 * this hook accumulates a history — it's the one place that does.
 */
import { useEffect, useRef, useState } from "react";
import type { CfxStatus } from "@zpcrweb/core";

export interface LiveThermalSample {
  /** Seconds since this run started — `status.elapsedS` (`usb.md` §3.2 field 8), not wall time. */
  atSeconds: number;
  blockTempC: number;
}

/** Generous relative to any real run: a poll every 1.5 s for 24 h is under 60,000 samples. */
const MAX_SAMPLES = 20000;

/**
 * Starts a fresh series whenever the run name changes or `elapsedS` goes backwards — both of
 * which mean a new run has begun, since `runName` persists across polls of the same run and
 * `elapsedS` only ever counts up within one.
 */
export function useLiveThermalHistory(status: CfxStatus | null): LiveThermalSample[] {
  const [samples, setSamples] = useState<LiveThermalSample[]>([]);
  const runKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!status?.running || status.blockTempC == null || status.elapsedS == null) return;
    const key = status.runName;
    const atSeconds = status.elapsedS;
    const blockTempC = status.blockTempC;

    setSamples((prev) => {
      const last = prev[prev.length - 1];
      const isNewRun = runKeyRef.current !== key || (!!last && atSeconds < last.atSeconds);
      runKeyRef.current = key;
      const base = isNewRun ? [] : prev;
      const baseLast = base[base.length - 1];
      if (baseLast && baseLast.atSeconds >= atSeconds) return base;
      const next = [...base, { atSeconds, blockTempC }];
      return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
    });
  }, [status]);

  return samples;
}
