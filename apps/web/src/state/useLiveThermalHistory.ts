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

export interface LiveThermalHistory {
  samples: LiveThermalSample[];
  /**
   * How long the whole run is expected to take, in seconds — `elapsedS + remainingS` from the
   * *first* poll of the run that reported a remaining time, and then held for the rest of it.
   *
   * Latched rather than recomputed each poll because the instrument's remaining time is an
   * estimate that drifts: it doesn't count plate reads or the initial lid heat (`usb.md` §3.2
   * field 10), so `elapsed + remaining` creeps upward as a run goes on. Re-reading it every tick
   * would give the chart a slowly-stretching axis, which is the thing a fixed axis is for. Null
   * until a poll reports a remaining time.
   */
  estimatedTotalS: number | null;
}

/** Generous relative to any real run: a poll every 1.5 s for 24 h is under 60,000 samples. */
const MAX_SAMPLES = 20000;

const EMPTY: LiveThermalHistory = { samples: [], estimatedTotalS: null };

/**
 * Starts a fresh series whenever the run name changes or `elapsedS` goes backwards — both of
 * which mean a new run has begun, since `runName` persists across polls of the same run and
 * `elapsedS` only ever counts up within one.
 */
export function useLiveThermalHistory(status: CfxStatus | null): LiveThermalHistory {
  const [history, setHistory] = useState<LiveThermalHistory>(EMPTY);
  const runKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!status?.running || status.blockTempC == null || status.elapsedS == null) return;
    const key = status.runName;
    const atSeconds = status.elapsedS;
    const blockTempC = status.blockTempC;
    const remainingS = status.remainingS;

    setHistory((prev) => {
      const last = prev.samples[prev.samples.length - 1];
      const isNewRun = runKeyRef.current !== key || (!!last && atSeconds < last.atSeconds);
      runKeyRef.current = key;
      const base = isNewRun ? EMPTY : prev;
      // A zero or absent remaining time says nothing; wait for a poll that has one.
      const estimatedTotalS =
        base.estimatedTotalS ?? (remainingS != null && remainingS > 0 ? atSeconds + remainingS : null);
      const baseLast = base.samples[base.samples.length - 1];
      if (baseLast && baseLast.atSeconds >= atSeconds) {
        return estimatedTotalS === base.estimatedTotalS ? base : { ...base, estimatedTotalS };
      }
      const next = [...base.samples, { atSeconds, blockTempC }];
      return {
        samples: next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next,
        estimatedTotalS,
      };
    });
  }, [status]);

  return history;
}
