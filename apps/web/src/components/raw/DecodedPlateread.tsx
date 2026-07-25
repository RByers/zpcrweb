import { useMemo, useState } from "react";
import { decodePlateReadDetail, type PlateRead, type Zpcr } from "@zpcrweb/core";
import { channelColor } from "../../lib/channelColors";

type Stat = "mean" | "std" | "min" | "max";
const STATS: Stat[] = ["mean", "std", "min", "max"];
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H", "R"];
const COLS = 12;

/**
 * Fully decoded view of a single `.Plateread`. Everything comes from the file's own
 * descriptor dictionary (self-describing schema), so no offsets are hardcoded here: the
 * version words, every named field with its offset/length/type and decoded value, the
 * DARKDATA table, and the WELLDATA fluorescence grid.
 */
export function DecodedPlateread({ zpcr, read }: { zpcr: Zpcr; read: PlateRead }) {
  const [channel, setChannel] = useState(2);
  const [stat, setStat] = useState<Stat>("mean");

  // A `.pcrd`-origin read has no real archive entry at all (a `.pcrd` has no inner files —
  // see Zpcr.archive's doc comment), so there's nothing to decode structurally; guard the
  // lookup rather than assuming `read.fileName` names a real entry. decodePlateReadDetail()
  // on empty bytes finds no ICFF footer and returns no fields, so the binary-only sections
  // below are skipped in that case.
  const bytes = useMemo(
    () => (zpcr.archive.entries.includes(read.fileName) ? zpcr.archive.bytes(read.fileName) : new Uint8Array(0)),
    [zpcr, read.fileName],
  );
  const detail = useMemo(() => decodePlateReadDetail(bytes), [bytes]);
  const isBinary = detail.fields.length > 0;
  const channelCount = read.dark.length;

  const fmt = (v: number) => (stat === "std" ? v.toFixed(2) : v.toFixed(1));

  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">File structure</h3>
        <dl className="decoded__dl mono">
          {isBinary && (
            <>
              <div className="decoded__pair">
                <dt>Size</dt>
                <dd>{detail.size.toLocaleString()} B</dd>
              </div>
              <div className="decoded__pair">
                <dt>Version</dt>
                <dd>{detail.versionWords.join(" · ")} (BE)</dd>
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
        {!isBinary && read.headerFields && read.headerFields.length > 0 && (
          <>
            <div className="decoded__gridwrap">
              <table className="decoded__tbl mono">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {read.headerFields.map((f) => (
                    <tr key={f.name}>
                      <td className="decoded__fname">{f.name}</td>
                      <td className="decoded__ftext">{f.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {isBinary && (
        <section className="decoded__block">
          <h3 className="decoded__h">
            Descriptor dictionary — every field, from the file's own schema
          </h3>
          <p className="decoded__hint mono">
            Scalars are big-endian; the WELLDATA/DARKDATA float arrays are little-endian.
            Fields with an unclear purpose are shown with their raw value.
          </p>
          <div className="decoded__gridwrap">
            <table className="decoded__tbl decoded__fields mono">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Offset</th>
                  <th>Len</th>
                  <th>Flag</th>
                  <th>int (BE)</th>
                  <th>float (BE)</th>
                  <th>text / hex</th>
                </tr>
              </thead>
              <tbody>
                {detail.fields.map((f) => (
                  <tr key={f.name}>
                    <td className="decoded__fname">{f.name}</td>
                    <td>0x{f.offset.toString(16)}</td>
                    <td>{f.length}</td>
                    <td>{f.flag}</td>
                    <td>{f.length === 4 ? f.int : ""}</td>
                    <td>
                      {f.length === 4 && f.float !== undefined
                        ? f.float.toFixed(Math.abs(f.float) < 1000 ? 3 : 0)
                        : ""}
                    </td>
                    <td className="decoded__ftext">
                      {f.text !== undefined
                        ? f.text
                        : f.length > 4
                          ? `«${f.length} B» 0x${f.hex}`
                          : ""}
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
                  C{i + 1}
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
                C{i + 1}
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
            C{channel + 1} · {stat}
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
