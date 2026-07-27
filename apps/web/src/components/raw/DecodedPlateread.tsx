import { useState } from "react";
import type { PlateRead } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../../lib/channelColors";

type Stat = "mean" | "std" | "min" | "max";
const STATS: Stat[] = ["mean", "std", "min", "max"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "R"];
const COLS = 12;

/**
 * Fully decoded view of a single plate read, from either source format. Everything is read
 * off the already-decoded `PlateRead`: its header fields as one key/value table (the binary
 * file's own descriptor dictionary or the `.pcrd` XML header's children — `PlateRead.fields`
 * unifies them, so nothing here re-parses a file or branches on format), the DARKDATA table,
 * and the WELLDATA fluorescence grid. The extra ICFF columns and the file-structure numbers
 * appear only when the read has a binary file behind it, since only then do they exist.
 */
export function DecodedPlateread({ read }: { read: PlateRead }) {
  const [channel, setChannel] = useState(2);
  const [stat, setStat] = useState<Stat>("mean");

  const binaryFile = read.binaryFile;
  const hasIcff = read.fields.some((f) => f.binary);
  const channelCount = read.dark.length;

  const fmt = (v: number) => (stat === "std" ? v.toFixed(2) : v.toFixed(1));

  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">File structure</h3>
        <dl className="decoded__dl mono">
          {binaryFile && (
            <>
              <div className="decoded__pair">
                <dt>Size</dt>
                <dd>{binaryFile.size.toLocaleString()} B</dd>
              </div>
              <div className="decoded__pair">
                <dt>Version</dt>
                <dd>{binaryFile.versionWords.join(" · ")} (BE)</dd>
              </div>
            </>
          )}
          <div className="decoded__pair">
            <dt>Cycle</dt>
            <dd>{read.cycle}</dd>
          </div>
          <div className="decoded__pair">
            <dt>Timestamp</dt>
            <dd>{read.timestamp ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {read.fields.length > 0 && (
        <section className="decoded__block">
          <h3 className="decoded__h">
            {hasIcff
              ? "Header fields — the file's own descriptor dictionary, every entry"
              : "Header fields — every element of the read's XML header"}
          </h3>
          {hasIcff && (
            <p className="decoded__hint mono">
              Scalars are big-endian; the WELLDATA/DARKDATA float arrays are little-endian.
              The dictionary carries no types, so Value is a best-effort reading — the raw
              columns beside it show every decoding of the same bytes.
            </p>
          )}
          <div className="decoded__gridwrap">
            <table className="decoded__tbl decoded__fields mono">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                  {hasIcff && (
                    <>
                      <th>Offset</th>
                      <th>Len</th>
                      <th>Flag</th>
                      <th>int (BE)</th>
                      <th>float (BE)</th>
                      <th>text / hex</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {read.fields.map((f) => {
                  const b = f.binary;
                  return (
                    <tr key={f.name}>
                      <td className="decoded__fname">{f.name}</td>
                      <td className="decoded__ftext">{f.value}</td>
                      {hasIcff && (
                        <>
                          <td>{b ? `0x${b.offset.toString(16)}` : ""}</td>
                          <td>{b?.length ?? ""}</td>
                          <td>{b?.flag ?? ""}</td>
                          <td>{b && b.length === 4 ? b.int : ""}</td>
                          <td>
                            {b && b.length === 4 && b.float !== undefined
                              ? b.float.toFixed(Math.abs(b.float) < 1000 ? 3 : 0)
                              : ""}
                          </td>
                          <td className="decoded__ftext">
                            {b?.text !== undefined
                              ? b.text
                              : b && b.length > 4
                                ? `«${b.length} B» 0x${b.hex}`
                                : ""}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="decoded__block">
        <h3 className="decoded__h">DARKDATA — LED-off background (per channel)</h3>
        <table className="decoded__tbl mono">
          <thead>
            <tr>
              <th>Ch</th>
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
                  <span className="decoded__swatch" style={{ background: channelColor(i) }} />
                  {channelLabel(i)}
                </td>
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
            {Array.from({ length: channelCount }, (_, i) => (
              <button
                key={i}
                className={"segmented__item" + (channel === i ? " is-active" : "")}
                onClick={() => setChannel(i)}
              >
                {channelLabel(i)}
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
            {channelLabel(channel)} · {stat}
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
                    <td key={col}>{fmt(read.wells[channel]![row]![col]![stat])}</td>
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
