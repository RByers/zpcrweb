import { useMemo, useState } from "react";
import type { Zpcr, WellCurve, DarkCurve } from "@zpcrweb/core";
import type { Baseline, FileSettings, RefXAxis, Scale } from "../../state/useZpcrStore";
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
 *
 * All three line kinds are the same channel color and sit within tens of RFU of each other, so
 * the dash pattern is what tells them apart: live solid, factory a fine dot, dark a dash-dot
 * (see `chart.ts`'s `DARK_DOT`/`FACTORY_DOT`).
 *
 * "Show factory" gates `drawFactory` rather than emptying `factoryCurves` — those values are
 * also what the ΔRFU/Drift % baselines are computed against, so clearing them to hide the line
 * would silently break both modes.
 *
 * "X axis" switches between cycles (the reference row's stability over the run, one line per
 * channel *and* column) and columns (its shape across the plate, one line per channel, each
 * point a mean over all cycles — where the dark overlay flattens out, since it has no column
 * dependence). Both go through the same chart: a series is just (x[], y[]).
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

  const factoryByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of factoryCal) m.set(`${f.channel},${f.col}`, f.mean);
    return m;
  }, [factoryCal]);

  /** The dark overlay only exists in the Raw baseline (see the class comment). */
  const showDark = settings.baseline === "raw" && settings.showDark;
  const byColumn = settings.refXAxis === "column";
  /** Column mode's x positions — one per reference column, whatever the run's plate width. */
  const colAxis = useMemo(() => Array.from({ length: columns }, (_, c) => c), [columns]);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

  /**
   * Cycle mode: one line per (channel, column) over the run, the reference row's *stability*.
   * Column mode: each of those lines collapses to its mean over all cycles, replotted against
   * the plate column — one line per channel across R1–R12, the reference row's *shape*. Both go
   * through the same `PlotCurve`/`buildChart` path; a series is just (x[], y[]), and column mode
   * only changes what x means (`xAxis` below relabels the axis to match). `col: -1` marks a
   * series that spans every column rather than pinning one — which is also how the factory
   * overlay is keyed to it below.
   */
  const plotCurves: PlotCurve[] = useMemo(() => {
    if (!byColumn) {
      return visibleRef.map((c) => ({
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
    }
    const channels = available.filter(
      (ch) => settings.enabledChannels.has(ch) || isHoveredChannel(ch),
    );
    return channels.flatMap((ch) => {
      // A column the rail has turned off leaves a gap in the line rather than shifting the rest
      // of the points along — NaN is what `buildChart` already treats as "no reading here".
      const values = colAxis.map((col) => {
        if (!(settings.enabledRefCols.has(col) || isHoveredCol(col))) return NaN;
        const c = refCurves.find((r) => r.channel === ch && r.col === col);
        return c ? mean(c.mean) : NaN;
      });
      if (values.every((v) => Number.isNaN(v))) return [];
      return [
        {
          channel: ch,
          dyeLabel: channelLabel(ch),
          row: -1,
          col: -1,
          wellLabel: channelLabel(ch),
          isReference: false,
          cycles: colAxis,
          mean: values,
        },
      ];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byColumn, visibleRef, available, refCurves, colAxis, settings.enabledChannels, settings.enabledRefCols, hover]);

  /** Matched to the plotted lines by `channel,col`, so column mode's whole-row series (`col: -1`)
   * picks up a factory line of the same shape — the factory value per column. This array is also
   * what the ΔRFU/Drift % baselines are computed against, which is why the "Show factory" toggle
   * gates `drawFactory` rather than emptying it. */
  const factoryCurves: FactoryCurve[] = useMemo(() => {
    if (!byColumn) {
      return visibleRef.flatMap((c) => {
        const m = factoryByKey.get(`${c.channel},${c.col}`);
        if (m == null) return [];
        return [{ channel: c.channel, col: c.col, mean: c.cycles.map(() => m) }];
      });
    }
    return plotCurves.flatMap((c) => {
      // Column mode always builds its series from a known channel, so this never falls through.
      if (c.channel == null) return [];
      const ch = c.channel;
      const values = colAxis.map((col) => factoryByKey.get(`${ch},${col}`) ?? NaN);
      if (values.every((v) => Number.isNaN(v))) return [];
      return [{ channel: ch, col: -1, mean: values }];
    });
  }, [byColumn, visibleRef, plotCurves, colAxis, factoryByKey]);

  /** The chart draws a dark curve only for channels its well curves already cover, so filtering
   * to the enabled channels here is belt-and-braces — but it keeps the rail's count honest. In
   * column mode the dark reading has no column dependence, so its single per-run value repeats
   * across every column: a flat line, exactly like the factory line is in cycle mode. */
  const darkCurves = useMemo(() => {
    if (!showDark) return [];
    const live = darkAll.filter(
      (d) =>
        available.includes(d.channel) &&
        (settings.enabledChannels.has(d.channel) || isHoveredChannel(d.channel)),
    );
    if (!byColumn) return live;
    return live.map((d) => {
      const flat = mean(d.mean.filter((v) => Number.isFinite(v)));
      return {
        ...d,
        cycles: colAxis,
        mean: colAxis.map(() => flat),
        // A run-averaged constant has no per-column spread to report.
        std: [],
        min: [],
        max: [],
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDark, byColumn, darkAll, available, colAxis, settings.enabledChannels, hover]);

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

          <div className="rail__section rail__row">
            {/* Cycle = the reference row's stability over the run; Column = its shape across the
                plate, each line collapsed to its mean over all cycles. */}
            <Toggle
              label="X axis"
              options={[
                ["cycle", "Cycle"],
                ["column", "Column"],
              ]}
              value={settings.refXAxis}
              onChange={(v) => onChange({ refXAxis: v as RefXAxis })}
            />
          </div>

          {/* Both overlays are Raw-baseline only, for the same reason from opposite directions:
              ΔRFU/Drift % already plot the live curve relative to the factory value, so the
              factory line would be a flat zero and the dark line has nothing to be relative to. */}
          <div className="rail__section rail__row">
            <Switch
              label="Show factory"
              checked={settings.showFactory}
              onChange={(v) => onChange({ showFactory: v })}
              title={
                settings.baseline === "raw"
                  ? "Overlay each reference well's factory calibration value (FactoryRefRowCal) as a flat dotted line"
                  : "ΔRFU and Drift % already plot each curve relative to its factory value — the line would be a flat zero"
              }
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

          {/* Counts what is actually drawn, so the factory switch is reflected here too —
              `factoryCurves` stays populated when the switch is off, since it's also the
              ΔRFU/Drift % reference. */}
          <div className="rail__stat mono">
            {plotCurves.length} reference {byColumn ? "columns" : "curves"}
            {settings.baseline === "delta"
              ? " · ΔRFU from factory"
              : settings.baseline === "percent"
                ? " · % drift from factory"
                : settings.showFactory
                  ? ` · ${factoryCurves.length} factory`
                  : " · factory hidden"}
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
            drawFactory={settings.showFactory}
            xAxis={
              byColumn
                ? {
                    label: "Reference column",
                    tickLabel: (v) => (Number.isInteger(v) ? `R${v + 1}` : ""),
                    splits: colAxis,
                  }
                : undefined
            }
            // See the RefColBar `onHover` above: in column mode a `refcol` match would find no
            // series to keep lit, so the peek stays and the dimming drops out.
            highlight={byColumn && hover?.kind === "refcol" ? null : hover}
          />
        </section>
      </div>

      <RefCalPanel zpcr={zpcr} />
    </div>
  );
}
