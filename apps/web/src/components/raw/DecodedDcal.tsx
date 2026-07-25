import { Fragment, useMemo } from "react";
import { findDcalBlock, parseDcal, type Dcal, type DcalBlock, type Zpcr } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../../lib/channelColors";

const TEMPS = [20, 40, 60, 80];

function fmtTemp(v?: number): string {
  return v === undefined ? "—" : `${v.toFixed(1)} °C`;
}

/**
 * Decoded view of a single `.Dcal`: the calibration's identity/provenance, a per-temperature
 * table of the dye and empty-plate channel response (well A1 — uniform across wells in every
 * file this library has decoded, see `dcal.md`), and the raw ICFF field list for anything not
 * surfaced above.
 */
export function DecodedDcal({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const bytes = useMemo(() => zpcr.archive.bytes(name), [zpcr, name]);
  const dcal = useMemo(() => parseDcal(bytes), [bytes]);

  const channels = Array.from({ length: dcal.channelCount }, (_, i) => i);

  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">
          {dcal.dye || "Dye"} on {dcal.plate || "plate"} —{" "}
          {dcal.factory ? "factory calibration" : "user calibration"}
        </h3>
        <dl className="decoded__dl mono">
          <Pair
            k="Primary channel"
            v={`${channelLabel(dcal.primaryChannel)} (${dcal.dye || "?"})`}
          />
          <Pair k="Channels × wells" v={`${dcal.channelCount} × ${dcal.wellCount}`} />
          <Pair
            k="Ambient / shuttle temp"
            v={`${fmtTemp(dcal.ambientTempC)} / ${fmtTemp(dcal.shuttleTempC)}`}
          />
          <Pair
            k="Serials (base · alpha · head)"
            v={
              [dcal.serials.base, dcal.serials.alpha, dcal.serials.head]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
          <Pair
            k="Calibrated"
            v={dcal.security.date ? dcal.security.date.toISOString().slice(0, 19) : "—"}
          />
          <Pair
            k="By"
            v={
              [
                dcal.security.fullName,
                dcal.security.app &&
                  `${dcal.security.app} ${dcal.security.appVersion ?? ""}`.trim(),
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
          {dcal.notes && <Pair k="Notes" v={dcal.notes} />}
        </dl>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">Channel response — well A1, by block temperature</h3>
        <p className="decoded__hint mono">
          One float per channel per well (a mean, not a std/min/max tuple). Values are uniform
          across wells in every file observed; well A1 (index 0) is shown. ★ marks this dye's
          primary channel.
        </p>
        <div className="decoded__gridwrap">
          <table className="decoded__tbl mono">
            <thead>
              <tr>
                <th>°C</th>
                <th>Plate</th>
                {channels.map((c) => (
                  <th key={c} style={{ color: channelColor(c) }}>
                    {channelLabel(c)}
                    {c === dcal.primaryChannel ? " ★" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TEMPS.map((t) => (
                <Fragment key={t}>
                  <BlockRow
                    label={String(t)}
                    rowLabel="Dye"
                    block={findDcalBlock(dcal, "dye", t)}
                    channels={channels}
                    primary={dcal.primaryChannel}
                  />
                  <BlockRow
                    label=""
                    rowLabel="Empty"
                    block={findDcalBlock(dcal, "empty", t)}
                    channels={channels}
                    primary={dcal.primaryChannel}
                  />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">All ICFF fields — every field in the file's own index</h3>
        <div className="decoded__gridwrap">
          <table className="decoded__tbl decoded__fields mono">
            <thead>
              <tr>
                <th>Field</th>
                <th>Offset</th>
                <th>Len</th>
                <th>int (BE)</th>
                <th>float (BE)</th>
                <th>text / hex</th>
              </tr>
            </thead>
            <tbody>
              {dcal.fields.map((f) => (
                <tr key={f.name}>
                  <td className="decoded__fname">{f.name}</td>
                  <td>0x{f.offset.toString(16)}</td>
                  <td>{f.length}</td>
                  <td>{f.length === 4 ? f.int : ""}</td>
                  <td>
                    {f.length === 4 && f.float !== undefined
                      ? f.float.toFixed(Math.abs(f.float) < 1000 ? 3 : 0)
                      : ""}
                  </td>
                  <td className="decoded__ftext">
                    {f.text !== undefined ? f.text : `«${f.length} B» 0x${f.hex}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function BlockRow({
  label,
  rowLabel,
  block,
  channels,
  primary,
}: {
  label: string;
  rowLabel: string;
  block: DcalBlock | undefined;
  channels: number[];
  primary: number;
}) {
  return (
    <tr>
      <th>{label}</th>
      <td>{rowLabel}</td>
      {channels.map((c) => (
        <td key={c} style={c === primary ? { fontWeight: 700 } : undefined}>
          {block ? block.values[c * block.wellCount]!.toFixed(1) : "—"}
        </td>
      ))}
    </tr>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <div className="decoded__pair">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
