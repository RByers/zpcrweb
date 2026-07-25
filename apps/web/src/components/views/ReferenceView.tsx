import { useMemo } from "react";
import type { Zpcr, WellCurve } from "@zpcrweb/core";
import type { Baseline, FileSettings, Scale } from "../../state/useZpcrStore";
import { channelLabel } from "../../lib/channelColors";
import { ChannelBar } from "../curves/ChannelBar";
import { RefColBar } from "../curves/RefColBar";
import { CurveChart } from "../curves/CurveChart";
import { Toggle } from "../Toggle";
import { RefCalPanel } from "./RefCalPanel";
import type { FactoryCurve, PlotCurve } from "../../lib/uplot/chart";

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

/**
 * Reference row only, plotted against the factory calibration: a solid line per (channel,
 * reference column) for the live reads, and — in the Raw baseline — a dotted flat line for
 * the matching `FactoryRefRowCal` value, the same dotted-overlay pattern as the Dark toggle
 * on the main Curves view (see `chart.ts`'s `factoryCurves`). Switching to ΔRFU replots the
 * live line as drift from the factory value (`live − factory`) rather than drift from the
 * run's own first cycle, so the (now redundant, always-zero) factory line is hidden instead.
 */
export function ReferenceView({ zpcr, settings, onChange }: Props) {
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  const available = useMemo(() => zpcr.channels(), [zpcr]);
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

  const refCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: true, step: activeStep }).filter((c) => c.isReference),
    [zpcr, activeStep],
  );
  const factoryCal = useMemo(() => zpcr.factoryRefCal(), [zpcr]);
  const columns = useMemo(
    () => Math.max(0, ...refCurves.map((c) => c.col + 1), ...factoryCal.map((c) => c.col + 1)),
    [refCurves, factoryCal],
  );

  const visibleRef = useMemo(
    () =>
      refCurves.filter(
        (c) =>
          available.includes(c.channel) &&
          settings.enabledChannels.has(c.channel) &&
          settings.enabledRefCols.has(c.col),
      ),
    [refCurves, available, settings.enabledChannels, settings.enabledRefCols],
  );

  const plotCurves: PlotCurve[] = visibleRef.map((c) => ({
    channel: c.channel,
    dyeLabel: channelLabel(c.channel),
    row: c.row,
    col: c.col,
    wellLabel: c.wellLabel,
    // Every curve here is a reference well, so the solid line is reserved for the live
    // reading and the dotted line for the factory overlay below — not for distinguishing
    // reference from sample wells, as it does on the main Curves view.
    isReference: false,
    cycles: c.cycles,
    mean: c.mean,
    std: c.std,
    min: c.min,
    max: c.max,
  }));

  const factoryByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of factoryCal) m.set(`${f.channel},${f.col}`, f.mean);
    return m;
  }, [factoryCal]);

  const factoryCurves: FactoryCurve[] = visibleRef.flatMap((c) => {
    const mean = factoryByKey.get(`${c.channel},${c.col}`);
    if (mean == null) return [];
    return [{ channel: c.channel, col: c.col, mean: c.cycles.map(() => mean) }];
  });

  const toggleChannel = (ch: number) => {
    const next = new Set(settings.enabledChannels);
    next.has(ch) ? next.delete(ch) : next.add(ch);
    onChange({ enabledChannels: next });
  };

  const toggleRefCol = (col: number) => {
    const next = new Set(settings.enabledRefCols);
    next.has(col) ? next.delete(col) : next.add(col);
    onChange({ enabledRefCols: next });
  };

  const onlyRefCol = (col: number) => {
    onChange({ enabledRefCols: new Set([col]) });
  };

  return (
    <div className="reference">
      <div className="reference__chart">
        <aside className="curves__rail">
          {steps.length > 1 && (
            <div className="rail__section">
              <div className="rail__title">Plate-read step</div>
              <div className="segmented segmented--sm stepsel">
                {steps.map((s, i) => (
                  <button
                    key={s.step}
                    className={"segmented__item" + (s.step === activeStep ? " is-active" : "")}
                    onClick={() => onChange({ step: s.step })}
                    title={`Protocol STEP ${s.step}, ${s.readCount} cycles`}
                  >
                    {i} · {s.readCount}c
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="rail__section">
            <div className="rail__title">Channels</div>
            <ChannelBar enabled={settings.enabledChannels} available={available} onToggle={toggleChannel} />
          </div>

          <div className="rail__section">
            <div className="rail__title">Reference columns</div>
            <RefColBar
              enabled={settings.enabledRefCols}
              columns={columns}
              onToggle={toggleRefCol}
              onOnly={onlyRefCol}
            />
          </div>

          <div className="rail__section rail__row">
            <Toggle
              label="Baseline"
              options={[
                ["raw", "Raw"],
                ["delta", "ΔRFU"],
              ]}
              value={settings.baseline}
              onChange={(v) => onChange({ baseline: v as Baseline })}
            />
            <Toggle
              label="Scale"
              options={[
                ["linear", "Linear"],
                ["log", "Log"],
              ]}
              value={settings.scale}
              onChange={(v) => onChange({ scale: v as Scale })}
            />
          </div>

          <div className="rail__stat mono">
            {plotCurves.length} reference curves
            {settings.baseline === "delta"
              ? " · ΔRFU from factory"
              : ` · ${factoryCurves.length} factory`}
          </div>
        </aside>

        <section className="curves__plot">
          <CurveChart
            curves={plotCurves}
            darkCurves={[]}
            factoryCurves={factoryCurves}
            tempCurves={[]}
            baseline={settings.baseline}
            scale={settings.scale}
            bands="off"
          />
        </section>
      </div>

      <RefCalPanel zpcr={zpcr} />
    </div>
  );
}
