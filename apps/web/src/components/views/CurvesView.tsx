import { useMemo } from "react";
import type { Zpcr, WellCurve, DarkCurve } from "@zpcrweb/core";
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
