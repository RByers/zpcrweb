import { useMemo, useState } from "react";
import type { Zpcr, RefCalComparison } from "@zpcrweb/core";
import { CHANNEL_INFO, channelColor, channelLabel } from "../../lib/channelColors";

type Stat = "drift" | "factory" | "live";
const STATS: { id: Stat; label: string }[] = [
  { id: "drift", label: "Drift %" },
  { id: "factory", label: "Factory" },
  { id: "live", label: "Live" },
];

/**
 * Reference-row vs factory-calibration grid: every reference column (R1–R12) × every channel
 * (C1–C6). Deviation is optical drift since factory calibration (e.g. LED aging), not sample
 * signal — shown as deviation from factory, not the instrument's applied correction.
 */
export function RefCalPanel({ zpcr }: { zpcr: Zpcr }) {
  const [stat, setStat] = useState<Stat>("drift");

  const { byColChannel, columns } = useMemo(() => {
    const cmp = zpcr.refCalComparison();
    const map = new Map<string, RefCalComparison>();
    let maxCol = -1;
    for (const c of cmp) {
      map.set(`${c.col},${c.channel}`, c);
      if (c.col > maxCol) maxCol = c.col;
    }
    return { byColChannel: map, columns: maxCol + 1 };
  }, [zpcr]);

  if (columns === 0) return null;

  const channels = CHANNEL_INFO.slice(
    0,
    Math.max(...[...byColChannel.values()].map((c) => c.channel + 1)),
  );

  const render = (c: RefCalComparison | undefined) => {
    if (!c) return { text: "—", big: false };
    if (stat === "factory") return { text: c.factoryMean.toFixed(0), big: false };
    if (stat === "live") return { text: c.liveMean.toFixed(0), big: false };
    const drift = (c.ratio - 1) * 100;
    return {
      text: `${drift >= 0 ? "+" : ""}${drift.toFixed(1)}`,
      big: Math.abs(drift) >= 5,
    };
  };

  return (
    <section className="overview__block refcal">
      <div className="refcal__side">
        <h2 className="overview__h">Reference row vs factory calibration</h2>
        <p className="refcal__note">
          Live reference reading (averaged over the run) vs the factory calibration
          (<code>FactoryRefRowCal</code>), for every reference column and channel. Deviation
          indicates optical drift since calibration (e.g. LED aging), not sample signal.
        </p>
        <div className="segmented segmented--sm">
          {STATS.map((s) => (
            <button
              key={s.id}
              className={"segmented__item" + (stat === s.id ? " is-active" : "")}
              onClick={() => setStat(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="refcal__legend mono">
          {stat === "drift"
            ? "% deviation of live from factory; ±≥5% highlighted."
            : `${stat === "factory" ? "Factory-calibrated" : "Live (run-averaged)"} mean fluorescence.`}
        </p>
      </div>
      <div className="decoded__gridwrap refcal__gridwrap">
        <table className="decoded__grid refcal__grid mono">
          <thead>
            <tr>
              <th />
              {channels.map((ch) => (
                <th key={ch.index}>
                  <span
                    className="decoded__swatch"
                    style={{ background: channelColor(ch.index) }}
                  />
                  {channelLabel(ch.index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: columns }, (_, col) => (
              <tr key={col}>
                <th title={`Reference column ${col + 1}`}>R{col + 1}</th>
                {channels.map((ch) => {
                  const cell = render(byColChannel.get(`${col},${ch.index}`));
                  return (
                    <td key={ch.index} className={cell.big ? "refcal__drift-big" : ""}>
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
