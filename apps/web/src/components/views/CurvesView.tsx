import { useMemo } from "react";
import type { Zpcr, WellCurve } from "@zpcrweb/core";
import {
  wellKey,
  type Baseline,
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
  // Full curve set (no reference row); derived once per file.
  const allCurves = useMemo<WellCurve[]>(
    () => zpcr.curves({ includeReference: false }),
    [zpcr],
  );

  const visible = useMemo(
    () =>
      allCurves.filter(
        (c) =>
          settings.enabledChannels.has(c.channel) &&
          settings.enabledWells.has(wellKey(c.row, c.col)),
      ),
    [allCurves, settings.enabledChannels, settings.enabledWells],
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
        <div className="rail__section">
          <div className="rail__title">Channels</div>
          <ChannelBar enabled={settings.enabledChannels} onToggle={toggleChannel} />
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
        </div>

        <div className="rail__stat mono">
          {visible.length} / {allCurves.length} curves
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
          baseline={settings.baseline}
          scale={settings.scale}
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
