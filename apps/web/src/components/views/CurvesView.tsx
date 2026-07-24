import { useMemo } from "react";
import type { Zpcr, WellCurve, DarkCurve, TemperatureCurve } from "@zpcrweb/core";
import {
  wellKey,
  type Baseline,
  type BandsMode,
  type FileSettings,
  type Scale,
} from "../../state/useZpcrStore";
import { ChannelBar } from "../curves/ChannelBar";
import { WellMatrix } from "../curves/WellMatrix";
import { CurveChart } from "../curves/CurveChart";
import { TempBar } from "../curves/TempBar";

interface Props {
  zpcr: Zpcr;
  settings: FileSettings;
  onChange: (patch: Partial<FileSettings>) => void;
}

export function CurvesView({ zpcr, settings, onChange }: Props) {
  const steps = useMemo(() => zpcr.steps(), [zpcr]);
  // Only channels actually scanned (CHANNELMASK) are offered/plotted.
  const available = useMemo(() => zpcr.channels(), [zpcr]);
  // Selected step: the stored one if still valid, else the first step.
  const activeStep =
    settings.step != null && steps.some((s) => s.step === settings.step)
      ? settings.step
      : (steps[0]?.step ?? undefined);

  // Full curve set for the active step, including the reference row.
  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: true, step: activeStep }),
    [zpcr, activeStep],
  );
  const darkCurves = useMemo<DarkCurve[]>(
    () => zpcr.darkCurves(activeStep),
    [zpcr, activeStep],
  );
  // Every temperature the platereads carry, for this step. Which of them are plotted is a
  // per-file setting; the right-hand axis appears only when at least one is selected.
  const allTemps = useMemo<TemperatureCurve[]>(
    () => zpcr.temperatureCurves(activeStep),
    [zpcr, activeStep],
  );
  const visibleTemps = useMemo(
    () => allTemps.filter((t) => settings.temps.has(t.key)),
    [allTemps, settings.temps],
  );

  const visible = useMemo(
    () =>
      allCurves.filter(
        (c) =>
          available.includes(c.channel) &&
          settings.enabledChannels.has(c.channel) &&
          settings.enabledWells.has(wellKey(c.row, c.col)),
      ),
    [allCurves, available, settings.enabledChannels, settings.enabledWells],
  );

  // Dark lines/subtraction only concern the enabled, available channels.
  const enabledDark = useMemo(
    () =>
      darkCurves.filter(
        (d) => available.includes(d.channel) && settings.enabledChannels.has(d.channel),
      ),
    [darkCurves, available, settings.enabledChannels],
  );

  const toggleTemp = (key: string) => {
    const next = new Set(settings.temps);
    next.has(key) ? next.delete(key) : next.add(key);
    onChange({ temps: next });
  };

  const toggleChannel = (ch: number) => {
    const next = new Set(settings.enabledChannels);
    next.has(ch) ? next.delete(ch) : next.add(ch);
    onChange({ enabledChannels: next });
  };

  const logDelta = settings.scale === "log" && settings.baseline === "delta";

  return (
    <div className="curves">
      <aside className="curves__rail">
        {steps.length > 1 && (
          <div className="rail__section">
            <div className="rail__title">Plate-read step</div>
            <div className="segmented segmented--sm stepsel">
              {steps.map((s, i) => (
                <button
                  key={s.step}
                  className={
                    "segmented__item" + (s.step === activeStep ? " is-active" : "")
                  }
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
          <ChannelBar
            enabled={settings.enabledChannels}
            available={available}
            onToggle={toggleChannel}
          />
        </div>

        <div className="rail__section">
          <div className="rail__title">Wells</div>
          <WellMatrix
            enabled={settings.enabledWells}
            onChange={(next) => onChange({ enabledWells: next })}
          />
        </div>

        {allTemps.length > 0 && (
          <div className="rail__section">
            <div className="rail__title">
              Temperature (right axis)
              <button
                className="rail__link"
                onClick={() =>
                  onChange({
                    temps:
                      visibleTemps.length > 0
                        ? new Set<string>()
                        : new Set(
                            allTemps.filter((t) => t.kind === "measured").map((t) => t.key),
                          ),
                  })
                }
              >
                {visibleTemps.length > 0 ? "none" : "all"}
              </button>
            </div>
            <TempBar temps={allTemps} enabled={settings.temps} onToggle={toggleTemp} />
          </div>
        )}

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
          <Toggle
            label="Dark (LED-off)"
            options={[
              ["off", "Show"],
              ["on", "Subtract"],
            ]}
            value={settings.subtractDark ? "on" : "off"}
            onChange={(v) => onChange({ subtractDark: v === "on" })}
          />
          <Toggle
            label="Min/max band"
            options={[
              ["off", "Off"],
              ["auto", "Auto"],
              ["on", "On"],
            ]}
            value={settings.bands}
            onChange={(v) => onChange({ bands: v as BandsMode })}
          />
        </div>

        <div className="rail__stat mono">
          {visible.length} / {allCurves.length} curves
          {!settings.subtractDark && " + dark"}
          {visibleTemps.length > 0 && ` + ${visibleTemps.length} temp`}
        </div>
        {logDelta && (
          <div className="rail__note mono">
            Log + ΔRFU: non-positive points are hidden (gaps).
          </div>
        )}
      </aside>

      <section className="curves__plot">
        <CurveChart
          curves={visible}
          darkCurves={enabledDark}
          tempCurves={visibleTemps}
          baseline={settings.baseline}
          scale={settings.scale}
          subtractDark={settings.subtractDark}
          bands={settings.bands}
        />
      </section>
    </div>
  );
}

function Toggle({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="toggle">
      <div className="toggle__label">{label}</div>
      <div className="segmented segmented--sm">
        {options.map(([val, text]) => (
          <button
            key={val}
            className={"segmented__item" + (value === val ? " is-active" : "")}
            onClick={() => onChange(val)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
