import { useState } from "react";
import type { PlateRead } from "@zpcrweb/core";
import { CHANNEL_INFO, channelColor, channelDye } from "../../lib/channelColors";

type Stat = "mean" | "std" | "min" | "max";
const STATS: Stat[] = ["mean", "std", "min", "max"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "R"];
const COLS = 12;

/**
 * Fully decoded view of a single `.Plateread`: the scalar header, the DARKDATA table, and
 * the WELLDATA fluorescence table as a per-channel plate grid (any of the four stats).
 */
export function DecodedPlateread({ read }: { read: PlateRead }) {
  const [channel, setChannel] = useState(2); // amplifying channel in the sample run
  const [stat, setStat] = useState<Stat>("mean");

  const header: [string, string][] = [
    ["File", read.fileName],
    ["Read index", String(read.index)],
    ["Cycle", String(read.cycle)],
    ["Block temp", read.blockTempC != null ? `${read.blockTempC.toFixed(2)} °C` : "—"],
    ["Timestamp", read.timestamp ?? "—"],
  ];

  const fmt = (v: number) => (stat === "std" ? v.toFixed(2) : v.toFixed(1));

  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">Header</h3>
        <dl className="decoded__dl mono">
          {header.map(([k, v]) => (
            <div className="decoded__pair" key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">DARKDATA — LED-off background (per channel)</h3>
        <table className="decoded__tbl mono">
          <thead>
            <tr>
              <th>Ch</th>
              <th>Dye</th>
              <th>mean</th>
              <th>std</th>
              <th>min</th>
              <th>max</th>
            </tr>
          </thead>
          <tbody>
            {read.dark.map((d, i) => (
              <tr key={i}>
                <td>
                  <span
                    className="decoded__swatch"
                    style={{ background: channelColor(i) }}
                  />
                  C{i + 1}
                </td>
                <td>{channelDye(i)}</td>
                <td>{d.mean.toFixed(1)}</td>
                <td>{d.std.toFixed(2)}</td>
                <td>{d.min.toFixed(1)}</td>
                <td>{d.max.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">WELLDATA — fluorescence table (6 ch × 108 wells)</h3>
        <div className="decoded__controls">
          <div className="segmented segmented--sm">
            {CHANNEL_INFO.map((c) => (
              <button
                key={c.index}
                className={"segmented__item" + (channel === c.index ? " is-active" : "")}
                onClick={() => setChannel(c.index)}
                title={c.dye}
              >
                C{c.index + 1}
              </button>
            ))}
          </div>
          <div className="segmented segmented--sm">
            {STATS.map((s) => (
              <button
                key={s}
                className={"segmented__item" + (stat === s ? " is-active" : "")}
                onClick={() => setStat(s)}
              >
                {s}
              </button>
            ))}
          </div>
          <span className="decoded__ctxt mono">
            C{channel + 1} · {channelDye(channel)} · {stat}
          </span>
        </div>

        <div className="decoded__gridwrap">
          <table className="decoded__grid mono">
            <thead>
              <tr>
                <th />
                {Array.from({ length: COLS }, (_, c) => (
                  <th key={c}>{c + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROW_LABELS.map((label, row) => (
                <tr key={label} className={row === 8 ? "decoded__refrow" : ""}>
                  <th>{label}</th>
                  {Array.from({ length: COLS }, (_, col) => (
                    <td key={col}>{fmt(read.get(channel, row, col)[stat])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
