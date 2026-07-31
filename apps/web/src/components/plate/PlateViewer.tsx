import type { CSSProperties, ReactNode } from "react";
import type { PlateDefinition, PlateFluor, WellDefinition } from "@zpcrweb/core";
import { channelColor } from "../../lib/channelColors";
import { FluorChannelChip, UnknownChannelNote, hasUnknownChannel } from "./FluorChannelChip";
import { ROW_LABELS, SAMPLE_TYPE_META } from "../../lib/sampleType";
import { plateDisplayName } from "../../lib/plateNames";
import { Pair } from "../raw/Pair";

/**
 * The visual plate map for any {@link PlateDefinition}: a `plate.rows`×`plate.columns` grid
 * (8×12 for a CFX block; a single row of as few as 3 positions for a Biomeme run's synthesized
 * plate — `biomeme.ts`) coloured by sample type,
 * each well showing its sample name and per-fluorophore targets (coloured by channel). Used both
 * by the "Plates" tab (for a `.zpcr`'s embedded `.pltd` entries) and a `.pcrd`'s already-decrypted
 * `plateSetup2` subtree — same component either way, only the source of the
 * {@link PlateDefinition} differs.
 *
 * There is no click-through detail panel: a well's remaining fields (replicate, quantity, the
 * fluor→channel→target mapping) are already in the cell's `title` tooltip, and the panel it used
 * to open cost a 320px column that a narrow container had to stack below the grid.
 */
export function PlateViewer({
  plate,
  sourceHint,
  toolbar,
}: {
  plate: PlateDefinition;
  sourceHint?: string;
  /** The view's attach/download controls, rendered on the heading line rather than above it —
   * see `.plateviewer__head`. Parents keep their own copy for the no-plate branches. */
  toolbar?: ReactNode;
}) {
  // Gated on `loaded` exactly as the cells are (see `WellCell`), so the legend lists the colors
  // actually on screen. Without the gate an unloaded well's configured sample type — often just
  // enum filler — added a swatch to the legend that no cell ever showed.
  const typesPresent = [...new Set(plate.wells.map((w) => (w.loaded ? w.sampleType : "empty")))];
  // The plate's fluors in optical-channel order (unknown channel last), which is both the chip
  // order and the row order every well cell follows: one line for the sample name, then one per
  // plate fluor, always at the same offset. A well that doesn't carry a given fluor leaves that
  // line blank rather than pulling the ones below it up, so a column of cells reads down its
  // channels — Ch3's target is on the Ch3 line whether or not the well also has Ch1. Reserving
  // the same lines everywhere is also what makes every row of the grid come out the same height.
  const fluorOrder = [...plate.fluors].sort((a, b) =>
    a.channel === undefined
      ? b.channel === undefined
        ? 0
        : 1
      : b.channel === undefined
        ? -1
        : a.channel - b.channel,
  );

  return (
    <div className="plateviewer">
      <section className="decoded__block">
        <div className="plateviewer__head">
          <h3 className="decoded__h">
            {plateDisplayName(plate)} — {plate.rows}×{plate.columns},{" "}
            {plate.dyeCount} {plate.dyeCount === 1 ? "dye" : "dyes"}
          </h3>
          {toolbar}
        </div>
        <dl className="decoded__dl mono">
          <Pair k="Vessel" v={plate.plateName || "—"} />
          <Pair k="Scan mode" v={plate.scanMode || "—"} />
          <Pair k="Plate type" v={plate.plateType || "—"} />
          <Pair k="Std units" v={plate.standardUnits || "—"} />
        </dl>
        <div className="plate__fluors">
          {fluorOrder.map((f) => (
            <FluorChannelChip key={f.fluor} fluor={f.fluor} channel={f.channel} />
          ))}
        </div>
        {hasUnknownChannel(plate.fluors) && <UnknownChannelNote />}
        {sourceHint && <span className="decoded__hint mono">{sourceHint}</span>}
      </section>

      <section className="decoded__block">
        <div className="decoded__gridwrap">
          <table
            className="decoded__grid plate__grid mono"
            style={{ "--plate-fluor-rows": Math.max(1, fluorOrder.length) } as CSSProperties}
          >
            <thead>
              <tr>
                <th />
                {Array.from({ length: plate.columns }, (_, c) => (
                  <th key={c}>{c + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROW_LABELS.slice(0, plate.rows).map((label, row) => (
                <tr key={label}>
                  {/* A single-row plate (e.g. a Biomeme run's synthesized strip of tube
                      positions — `biomeme.ts`) has no row to distinguish, so the header cell is
                      left blank rather than showing the redundant, always-"A" row letter. */}
                  <th>{plate.rows === 1 ? "" : label}</th>
                  {Array.from({ length: plate.columns }, (_, col) => (
                    <WellCell
                      key={col}
                      well={plate.wells[row * plate.columns + col]!}
                      fluorOrder={fluorOrder}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="plate__legend mono">
          {typesPresent.map((t) => (
            <span key={t} className="plate__legitem">
              <span className="plate__legdot" style={{ background: SAMPLE_TYPE_META[t].color }} />
              {SAMPLE_TYPE_META[t].label}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

/** One well: a line for the sample name, then one line per plate fluor in `fluorOrder`, blank
 * where this well doesn't carry that fluor. The `title` carries everything the cell has no room
 * to show — replicate, quantity, the full fluor→target list — which is why there's no
 * click-through panel. */
function WellCell({ well, fluorOrder }: { well: WellDefinition; fluorOrder: PlateFluor[] }) {
  const meta = SAMPLE_TYPE_META[well.sampleType];
  const title = [
    well.label,
    meta.label,
    well.sample && `Sample: ${well.sample}`,
    well.replicate !== undefined && `Rep ${well.replicate}`,
    well.quantity !== undefined && `Qty ${well.quantity}`,
    well.fluors.length
      ? "Fluors: " +
        well.fluors.map((f) => (f.target ? `${f.fluor}→${f.target}` : f.fluor)).join(", ")
      : "not loaded",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <td
      className={"plate__well" + (well.loaded ? "" : " is-empty")}
      style={well.loaded ? { background: meta.color + "22", borderColor: meta.color + "55" } : undefined}
      title={title}
    >
      {well.loaded && (
        <>
          {/* Always rendered, even unnamed: the empty line keeps the target list starting at the
              same height in every well, which is the point of the fixed row height. */}
          <span className="plate__wellsample">{well.sample}</span>
          <span className="plate__welltargets">
            {fluorOrder.map((pf) => {
              // Blank, not skipped, when this well doesn't carry the fluor: the line belongs to
              // the plate's fluor, not to the well's Nth one, so targets stay in channel order
              // down the cell no matter which dyes a given well happens to use.
              const f = well.fluors.find((wf) => wf.fluor === pf.fluor);
              return (
                <span
                  key={pf.fluor}
                  className="plate__target"
                  style={f ? { color: channelColor(pf.channel) } : undefined}
                >
                  {f ? f.target || f.fluor : ""}
                </span>
              );
            })}
          </span>
        </>
      )}
    </td>
  );
}
