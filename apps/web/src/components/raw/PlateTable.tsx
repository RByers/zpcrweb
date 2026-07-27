import { isBlankWell, type PlateDefinition } from "@zpcrweb/core";
import {
  FluorChannelChip,
  UnknownChannelNote,
  hasUnknownChannel,
} from "../plate/FluorChannelChip";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import { plateDisplayName } from "../../lib/plateNames";

/**
 * Raw plate data as a table: one row per well that carries anything, in plate order, with its
 * sample type, sample identity, and loaded fluorophores → targets. Wells with nothing at all in
 * them are skipped — the same {@link isBlankWell} test that leaves them out of a `.plt.csv`, so
 * the table shows exactly what a round-trip through that format would keep, rather than pages of
 * empty rows. This is the "Raw files" Decoded view for a `.pltd` entry — for the color-coded
 * visual plate map, see the "Plates" tab
 * ({@link import("../plate/PlateViewer").PlateViewer}).
 */
export function PlateTable({ plate, sourceHint }: { plate: PlateDefinition; sourceHint?: string }) {
  const wells = plate.wells.filter((w) => !isBlankWell(w));
  const hidden = plate.wells.length - wells.length;
  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">
          {plateDisplayName(plate)} — {plate.rows}×{plate.columns}, {plate.dyeCount}{" "}
          {plate.dyeCount === 1 ? "dye" : "dyes"}
        </h3>
        <dl className="decoded__dl mono">
          <div className="decoded__pair">
            <dt>Vessel</dt>
            <dd>{plate.plateName || "—"}</dd>
          </div>
          <div className="decoded__pair">
            <dt>Scan mode</dt>
            <dd>{plate.scanMode || "—"}</dd>
          </div>
          <div className="decoded__pair">
            <dt>Plate type</dt>
            <dd>{plate.plateType || "—"}</dd>
          </div>
          <div className="decoded__pair">
            <dt>Std units</dt>
            <dd>{plate.standardUnits || "—"}</dd>
          </div>
        </dl>
        {hasUnknownChannel(plate.fluors) && <UnknownChannelNote />}
        {sourceHint && <span className="decoded__hint mono">{sourceHint}</span>}
      </section>

      <section className="decoded__block">
        <div className="decoded__gridwrap">
          <table className="decoded__tbl mono">
            <thead>
              <tr>
                <th>Well</th>
                <th>Type</th>
                <th>Sample</th>
                <th>Rep</th>
                <th>Qty</th>
                <th>Fluors → targets</th>
              </tr>
            </thead>
            <tbody>
              {wells.map((w) => {
                const meta = SAMPLE_TYPE_META[w.sampleType];
                return (
                  <tr key={w.index} className={w.loaded ? "" : "decoded__refrow"}>
                    <td>{w.label}</td>
                    <td>
                      <span className="decoded__swatch" style={{ background: meta.color }} />
                      {meta.label}
                    </td>
                    <td>{w.sample ?? <span className="decoded__empty">∅</span>}</td>
                    <td>{w.replicate ?? ""}</td>
                    <td>{w.quantity ?? ""}</td>
                    <td>
                      {w.fluors.length ? (
                        <span className="plate__fluors plate__fluors--inline">
                          {w.fluors.map((f) => (
                            <FluorChannelChip
                              key={f.fluor}
                              fluor={f.fluor + (f.target ? `→${f.target}` : "")}
                              channel={f.channel}
                              compact
                            />
                          ))}
                        </span>
                      ) : (
                        <span className="decoded__empty">∅</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {hidden > 0 && (
          <span className="decoded__hint mono">
            {hidden} empty {hidden === 1 ? "well" : "wells"} not shown
          </span>
        )}
      </section>
    </div>
  );
}
