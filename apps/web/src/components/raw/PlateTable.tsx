import type { PlateDefinition } from "@zpcrweb/core";
import { channelColor } from "../../lib/channelColors";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";

/**
 * Raw plate data as a table: one row per well, in plate order, with its sample type, sample
 * identity, and loaded fluorophores → targets. This is the "Raw files" Decoded view for a
 * `.pltd` entry — for the color-coded visual plate map, see the "Plates" tab
 * ({@link import("../plate/PlateViewer").PlateViewer}).
 */
export function PlateTable({ plate, sourceHint }: { plate: PlateDefinition; sourceHint?: string }) {
  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">
          {plate.plateName || "Plate"} — {plate.rows}×{plate.columns}, {plate.dyeCount}{" "}
          {plate.dyeCount === 1 ? "dye" : "dyes"}
        </h3>
        <dl className="decoded__dl mono">
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
              {plate.wells.map((w) => {
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
                            <span key={f.channel} className="plate__chip mono">
                              <span
                                className="decoded__swatch"
                                style={{ background: channelColor(f.channel) }}
                              />
                              {f.fluor}
                              {f.target ? `→${f.target}` : ""}
                            </span>
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
      </section>
    </div>
  );
}
