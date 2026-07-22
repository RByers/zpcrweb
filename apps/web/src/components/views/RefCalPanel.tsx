import { useMemo } from "react";
import type { Zpcr, RefCalComparison } from "@zpcrweb/core";
import { channelColor, channelDye } from "../../lib/channelColors";

/**
 * Reference-row vs factory-calibration panel: the live reference reading (averaged over the
 * run) against `FactoryRefRowCal`, shown per channel at that channel's brightest reference
 * position. The deviation is optical drift (e.g. LED aging) since factory calibration — a
 * property of the instrument, not the samples.
 */
export function RefCalPanel({ zpcr }: { zpcr: Zpcr }) {
  const perChannel = useMemo(() => {
    const best = new Map<number, RefCalComparison>();
    for (const c of zpcr.refCalComparison()) {
      const cur = best.get(c.channel);
      if (!cur || c.factoryMean > cur.factoryMean) best.set(c.channel, c);
    }
    return [...best.values()].sort((a, b) => a.channel - b.channel);
  }, [zpcr]);

  if (perChannel.length === 0) return null;

  return (
    <section className="overview__block">
      <h2 className="overview__h">Reference row vs factory calibration</h2>
      <p className="refcal__note">
        Live reference reading (averaged over the run) vs the factory calibration
        (<code>FactoryRefRowCal</code>), at each channel's brightest reference position.
        Deviation indicates optical drift since calibration (e.g. LED aging), not sample
        signal. Shown as deviation from factory, not the instrument's applied correction.
      </p>
      <table className="decoded__tbl refcal__tbl mono">
        <thead>
          <tr>
            <th>Channel</th>
            <th>Col</th>
            <th>Factory</th>
            <th>Live</th>
            <th>Drift</th>
          </tr>
        </thead>
        <tbody>
          {perChannel.map((c) => {
            const drift = (c.ratio - 1) * 100;
            const big = Math.abs(drift) >= 5;
            return (
              <tr key={c.channel}>
                <td>
                  <span
                    className="decoded__swatch"
                    style={{ background: channelColor(c.channel) }}
                  />
                  C{c.channel + 1} · {channelDye(c.channel)}
                </td>
                <td>{c.col + 1}</td>
                <td>{c.factoryMean.toFixed(0)}</td>
                <td>{c.liveMean.toFixed(0)}</td>
                <td className={big ? "refcal__drift-big" : ""}>
                  {drift >= 0 ? "+" : ""}
                  {drift.toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
