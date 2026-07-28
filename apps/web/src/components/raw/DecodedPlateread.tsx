import { useState } from "react";
import type { PlateRead } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../../lib/channelColors";
import { LongValue } from "./LongValue";

type Stat = "mean" | "std" | "min" | "max";
const STATS: Stat[] = ["mean", "std", "min", "max"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "R"];
const COLS = 12;

/**
 * Fully decoded view of a single plate read, from either source format. Everything is read
 * off the already-decoded `PlateRead`: its header fields as one key/value table (the binary
 * file's own descriptor dictionary or the `.pcrd` XML header's children — `PlateRead.fields`
 * unifies them, so nothing here re-parses a file or branches on format), the DARKDATA table,
 * and the WELLDATA fluorescence grid.
 *
 * The fields table is exactly two columns, for both formats. It used to widen to eight for a
 * binary read — offset, length, flag, int (BE), float (BE), text/hex — which meant this
 * component knew about ICFF layout and endianness, and had to re-guess a field's type after
 * the library had already guessed it. The library now types each value once
 * (`PlateReadField.value`); the raw byte view lives behind `decodePlateReadDetail`, where
 * binary-format work belongs. Only the file-structure numbers still branch, because a
 * `.pcrd`-origin read genuinely has no file behind it.
 */
export function DecodedPlateread({ read }: { read: PlateRead }) {
  const [channel, setChannel] = useState(2);
  const [stat, setStat] = useState<Stat>("mean");

  const binaryFile = read.binaryFile;
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
            {binaryFile
              ? "Header fields — the file's own descriptor dictionary, every entry"
              : "Header fields — every element of the read's XML header"}
          </h3>
          {binaryFile && (
            <p className="decoded__hint mono">
              The dictionary carries no types, so each value is the library's own reading of an
              untyped byte range (see <code>PlateReadField.value</code>).
            </p>
          )}
          <div className="decoded__gridwrap">
            <table className="decoded__tbl decoded__fields mono">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {read.fields.map((f) => (
                  <tr key={f.name}>
                    <td className="decoded__fname">{f.name}</td>
                    <td>
                      <LongValue value={f.value} />
                    </td>
                  </tr>
                ))}
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
