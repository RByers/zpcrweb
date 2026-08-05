import type { CSSProperties, ReactNode } from "react";
import {
  fileKindDescription,
  type FileKind,
  type PlateDefinition,
  type PlateFluor,
  type WellDefinition,
} from "@zpcrweb/core";
import { fluorColor } from "../../lib/fluorColors";
import { FluorChannelChip } from "./FluorChannelChip";
import { ROW_LABELS, SAMPLE_TYPE_META } from "../../lib/sampleType";
import { plateDisplayName } from "../../lib/plateNames";
import { useHoverCard, type HoverCardData, type HoverCardRow } from "../curves/HoverCard";
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
 * fluor→channel→target mapping) are already in the cell's hover card ({@link wellCard} — the same
 * card the Curves view's well grid shows, minus the Cq column), and the panel it used to open cost
 * a 320px column that a narrow container had to stack below the grid.
 */
export function PlateViewer({
  plate,
  kind,
  sourceHint,
  toolbar,
  compact,
}: {
  plate: PlateDefinition;
  /** The standalone file's own kind (`pltd` or `csv`) — only passed by
   * `StandalonePlateView`, whose plate *is* a top-level file with a kind of its own. The "Plates"
   * tab of a run has no such prop: its plate is a piece of the run's archive, not a file in its
   * own right, so there is nothing to describe that the run's own "Type" row (`OverviewView`)
   * doesn't already say. */
  kind?: FileKind;
  sourceHint?: string;
  /** The view's attach/download controls, rendered on the heading line rather than above it —
   * see `.plateviewer__head`. Parents keep their own copy for the no-plate branches. */
  toolbar?: ReactNode;
  /**
   * Preview variant: drop the vessel/scan-mode metadata and shrink the wells to colour-coded
   * cells, so a full 12-column plate fits a narrow column instead of scrolling sideways out of
   * it. A loaded well keeps a row of channel-coloured dots, one per fluor it carries, so a cell
   * still says at a glance what is in it; nothing else is lost that isn't one hover away — each
   * cell keeps its full card ({@link wellCard}) — and
   * the fluor chips above still name the dyes. Used by the Instrument view's staged run, where the
   * plate sits beside a protocol and the question is "is this the right plate?", not "what is in
   * well F7?".
   */
  compact?: boolean;
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

  // Keyed by the `WellDefinition` itself rather than by label: the grid already has the well in
  // hand at the point it hovers, and a Biomeme strip's positions are labelled by column alone.
  const { show, hide, node } = useHoverCard((well: WellDefinition) => wellCard(well, fluorOrder));

  return (
    <div className={"plateviewer" + (compact ? " plateviewer--compact" : "")}>
      <section className="decoded__block">
        <div className="plateviewer__head">
          <h3 className="decoded__h">
            {plateDisplayName(plate)} — {plate.rows}×{plate.columns},{" "}
            {plate.dyeCount} {plate.dyeCount === 1 ? "dye" : "dyes"}
          </h3>
          {toolbar}
        </div>
        {!compact && (
          <dl className="decoded__dl mono">
            {kind && <Pair k="Type" v={fileKindDescription(kind)} />}
            <Pair k="Vessel" v={plate.plateName || "—"} />
            <Pair k="Scan mode" v={plate.scanMode || "—"} />
            <Pair k="Plate type" v={plate.plateType || "—"} />
            <Pair k="Std units" v={plate.standardUnits || "—"} />
          </dl>
        )}
        <div className="plate__fluors">
          {fluorOrder.map((f) => (
            <FluorChannelChip key={f.fluor} fluor={f.fluor} channel={f.channel} />
          ))}
        </div>
        {sourceHint && !compact && <span className="decoded__hint mono">{sourceHint}</span>}
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
                      show={show}
                      hide={hide}
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
      {node}
    </div>
  );
}

/** Hover-card content for one well: what it holds, in the plate's own fluor order. Mirrors the
 * Curves view's well card (`CurvesView`'s `cardForWell`) — same title, same sample-type/sample
 * subtitle, same channel-coloured swatch per fluor — minus the Cq column, since a plate
 * *definition* is a setup, with no run and so nothing quantified. Every fluor listed is one the
 * well carries, so every row is `selected`; the dimmed state has no meaning without a rail to
 * filter by. */
function wellCard(well: WellDefinition, fluorOrder: PlateFluor[]): HoverCardData {
  // Sample type reads as "empty" for an unloaded well however the plate design typed it, exactly
  // as the cell's own colouring does (see `WellCell`).
  const meta = SAMPLE_TYPE_META[well.loaded ? well.sampleType : "empty"];
  const subtitle = [
    meta.label,
    well.sample ? `Sample: ${well.sample}` : null,
    well.replicate !== undefined ? `Rep ${well.replicate}` : null,
    well.quantity !== undefined ? `Qty ${well.quantity}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const rows: HoverCardRow[] = fluorOrder.flatMap((pf) => {
    const f = well.fluors.find((wf) => wf.fluor === pf.fluor);
    if (!f) return [];
    return [
      {
        key: pf.fluor,
        label: pf.fluor,
        sublabel: f.target || undefined,
        color: fluorColor(pf.fluor),
        selected: true,
      },
    ];
  });

  return { title: `Well ${well.label}`, subtitle, rows, empty: "Not loaded" };
}

/** One well: a line for the sample name, then one line per plate fluor in `fluorOrder`, blank
 * where this well doesn't carry that fluor — plus a row of channel-coloured dots, one per fluor
 * the well actually carries, which is all the compact variant has room for (the text lines are
 * hidden there). Everything the cell can't show — replicate, quantity, the full fluor→target
 * list — is one hover away in {@link wellCard}, which is why there's no click-through panel. */
function WellCell({
  well,
  fluorOrder,
  show,
  hide,
}: {
  well: WellDefinition;
  fluorOrder: PlateFluor[];
  show: (well: WellDefinition, el: HTMLElement) => void;
  hide: () => void;
}) {
  const meta = SAMPLE_TYPE_META[well.sampleType];

  return (
    <td
      className={"plate__well" + (well.loaded ? "" : " is-empty")}
      style={well.loaded ? { background: meta.color + "22", borderColor: meta.color + "55" } : undefined}
      onMouseEnter={(e) => show(well, e.currentTarget)}
      onMouseLeave={hide}
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
                  style={f ? { color: fluorColor(pf.fluor) } : undefined}
                >
                  {f ? f.target || f.fluor : ""}
                </span>
              );
            })}
          </span>
          {/* Only the fluors present, unlike the target lines above: a dot row is read across,
              not down a column of cells, so there is no line to hold open — and in a 26px-wide
              compact cell, blanks for the plate's other dyes would crowd out the real ones. */}
          <span className="plate__welldots">
            {fluorOrder
              .filter((pf) => well.fluors.some((wf) => wf.fluor === pf.fluor))
              .map((pf) => (
                <span
                  key={pf.fluor}
                  className="plate__welldot"
                  style={{ background: fluorColor(pf.fluor) }}
                />
              ))}
          </span>
        </>
      )}
    </td>
  );
}
