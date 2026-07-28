import { useMemo, useState } from "react";
import type { Zpcr, WellCurve, DarkCurve } from "@zpcrweb/core";
import type { Baseline, FileSettings, Scale } from "../../state/useZpcrStore";
import { channelLabel } from "../../lib/channelColors";
import { ChannelBar } from "../curves/ChannelBar";
import { RefColBar } from "../curves/RefColBar";
import { CurveChart } from "../curves/CurveChart";
import { Toggle } from "../Toggle";
import { Switch } from "../Switch";
import { ResetIcon } from "../ResetIcon";
import { RefCalPanel } from "./RefCalPanel";
import type { FactoryCurve, HighlightMatch, PlotCurve } from "../../lib/uplot/chart";
import { noRightAxis } from "../../lib/rightAxis";

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
 * live line as drift from the factory value (`live − factory`), so the (now redundant,
 * always-zero) factory line is hidden instead. This view's baselining is always
 * factory-relative — see `chart.ts`'s `curveView`, which the main Curves view uses instead and
 * which this view always passes `"absolute"` (a no-op).
 *
 * "Show dark" adds each enabled channel's DARKDATA (LED-off background) curve as a dotted line
 * alongside the reference reads — the comparison that makes the reference row's *absolute* level
 * interpretable, since across every committed sample the dark level lands below every reference
 * column by a stable per-channel offset (see `plateread.md` §DARKDATA vs. the reference row).
 * Raw-baseline only: a dark curve has no factory value to be relative to, so ΔRFU/Drift% have
 * nothing to plot it against and would put a ~2000 RFU line on an axis spanning tens of RFU.
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
  const darkAll = useMemo<DarkCurve[]>(() => zpcr.darkCurves(activeStep), [zpcr, activeStep]);
  const factoryCal = useMemo(() => zpcr.factoryRefCal(), [zpcr]);
  const columns = useMemo(
    () => Math.max(0, ...refCurves.map((c) => c.col + 1), ...factoryCal.map((c) => c.col + 1)),
    [refCurves, factoryCal],
  );

  // Hovering a rail chip both dims the rest of the chart and "peeks" at the hovered chip when
  // it is itself turned off — the same contract the Curves rail has (see `ChipBar`), which is
  // why the visibility filter below lets the hovered channel/column bypass its *own* enabled
  // check (only its own: peeking a disabled column doesn't also reveal disabled channels).
  const [hover, setHover] = useState<HighlightMatch | null>(null);
  const isHoveredChannel = (ch: number) => hover?.kind === "channel" && hover.channel === ch;
  const isHoveredCol = (col: number) => hover?.kind === "refcol" && hover.col === col;

  const visibleRef = useMemo(
    () =>
      refCurves.filter(
        (c) =>
          available.includes(c.channel) &&
          (settings.enabledChannels.has(c.channel) || isHoveredChannel(c.channel)) &&
          (settings.enabledRefCols.has(c.col) || isHoveredCol(c.col)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refCurves, available, settings.enabledChannels, settings.enabledRefCols, hover],
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

  /** The dark overlay only exists in the Raw baseline (see the class comment). The chart draws a
   * dark curve only for channels its well curves already cover, so filtering to the enabled
   * channels here is belt-and-braces — but it keeps the rail's count honest. */
  const showDark = settings.baseline === "raw" && settings.showDark;
  const darkCurves = useMemo(
    () =>
      showDark
        ? darkAll.filter(
            (d) =>
              available.includes(d.channel) &&
              (settings.enabledChannels.has(d.channel) || isHoveredChannel(d.channel)),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showDark, darkAll, available, settings.enabledChannels, hover],
  );

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

  // Double-clicking any chip isolates it within its own dimension, as everywhere else.
  const soloChannel = (ch: number) => onChange({ enabledChannels: new Set([ch]) });
  const soloRefCol = (col: number) => onChange({ enabledRefCols: new Set([col]) });

  // The default selection both reset buttons restore. Unlike the Curves view's, neither is
  // plate-derived: the reference row is instrument optics read on every channel, whatever the
  // plate happens to hold.
  const resetChannels = () => onChange({ enabledChannels: new Set(available) });
  const resetRefCols = () =>
    onChange({ enabledRefCols: new Set(Array.from({ length: columns }, (_, c) => c)) });

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
            <div className="rail__title">
              Channels
              <button
                className="rail__link rail__icon-btn"
                onClick={resetChannels}
                title="Reset to every channel this run reads"
                aria-label="Reset to every channel this run reads"
              >
                <ResetIcon />
              </button>
            </div>
            <ChannelBar
              enabled={settings.enabledChannels}
              available={available}
              onToggle={toggleChannel}
              onHover={(ch) => setHover(ch != null ? { kind: "channel", channel: ch } : null)}
              onSolo={soloChannel}
            />
          </div>

          <div className="rail__section">
            <div className="rail__title">
              Reference columns
              <button
                className="rail__link rail__icon-btn"
                onClick={resetRefCols}
                title="Reset to every reference column"
                aria-label="Reset to every reference column"
              >
                <ResetIcon />
              </button>
            </div>
            <RefColBar
              enabled={settings.enabledRefCols}
              columns={columns}
              onToggle={toggleRefCol}
              onHover={(col) => setHover(col != null ? { kind: "refcol", col } : null)}
              onSolo={soloRefCol}
            />
          </div>

          <div className="rail__section rail__row">
            <Toggle
              label="Baseline"
              options={[
                ["raw", "Raw"],
                ["delta", "ΔRFU"],
                ["percent", "Drift %"],
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

          {/* Same switch (and same setting) as the Curves view's channel-space "Show dark" —
              one toggle meaning "overlay the LED-off background", wherever raw channel readings
              are on screen. */}
          <div className="rail__section rail__row">
            <Switch
              label="Show dark"
              checked={settings.showDark}
              onChange={(v) => onChange({ showDark: v })}
              title={
                settings.baseline === "raw"
                  ? "Overlay each channel's LED-off DARKDATA background as a dotted line — it sits just below the dim end of the reference row"
                  : "Dark has no factory value to be relative to — switch the baseline to Raw to overlay it"
              }
            />
          </div>

          <div className="rail__stat mono">
            {plotCurves.length} reference curves
            {settings.baseline === "delta"
              ? " · ΔRFU from factory"
              : settings.baseline === "percent"
                ? " · % drift from factory"
                : ` · ${factoryCurves.length} factory`}
            {darkCurves.length > 0 && ` + ${darkCurves.length} dark`}
          </div>
          {settings.showDark && settings.baseline !== "raw" && (
            <div className="rail__note mono">
              Dark is Raw-baseline only: it has no factory reference to plot ΔRFU or drift
              against.
            </div>
          )}
        </aside>

        <section className="curves__plot">
          <CurveChart
            curves={plotCurves}
            darkCurves={darkCurves}
            factoryCurves={factoryCurves}
            aux={noRightAxis()}
            baseline={settings.baseline}
            curveView="absolute"
            drawBaseline={false}
            scale={settings.scale}
            bands={false}
            highlight={hover}
          />
        </section>
      </div>

      <RefCalPanel zpcr={zpcr} />
    </div>
  );
}
