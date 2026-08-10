import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import {
  fileKindDescription,
  type FileKind,
  type PlateDefinition,
  type PlateFluor,
  type WellDefinition,
} from "@zpcrweb/core";
import { fluorColor, isKnownFluor } from "../../lib/fluorColors";
import { FluorChannelChip } from "./FluorChannelChip";
import { ROW_LABELS, SAMPLE_TYPE_META } from "../../lib/sampleType";
import { plateDisplayName, plateVesselLabel } from "../../lib/plateNames";
import { useHoverCard, type HoverCardData, type HoverCardRow } from "../curves/HoverCard";
import { Pair } from "../raw/Pair";

/**
 * The visual plate map for any {@link PlateDefinition}: a `plate.rows`×`plate.columns` grid
 * (8×12 for a CFX block; a single row of as few as 3 positions for a Biomeme run's synthesized
 * plate — `biomeme.ts`) coloured by sample type,
 * each well showing its sample name and one target line per optical channel (coloured by dye —
 * see {@link fluorLine}). Used both
 * by the "Plates" tab (for a `.zpcr`'s embedded `.pltd` entries) and a `.pcrd`'s already-decrypted
 * `plateSetup2` subtree — same component either way, only the source of the
 * {@link PlateDefinition} differs.
 *
 * There is no click-through detail panel *while reading*: a well's remaining fields (replicate,
 * quantity, the fluor→channel→target mapping) are already in the cell's hover card
 * ({@link wellCard} — the same card the Curves view's well grid shows, minus the Cq column), and
 * the panel it used to open cost a 320px column that a narrow container had to stack below the
 * grid. Editing is the one state where a panel earns that column back, and {@link PlateEditor}
 * supplies it — this component stays the single plate grid either way, taking the selection as a
 * prop rather than being forked into a read copy and an edit copy.
 */
/**
 * The grid's editing behaviour, supplied by {@link PlateEditor} while its edit mode is on and
 * absent the rest of the time — which is exactly what "the grid is selectable now" means.
 *
 * Spreadsheet conventions throughout: a plain click selects one well, Cmd/Ctrl-click adds to the
 * selection, Shift-click extends a rectangle from the anchor, dragging sweeps one out, and the row
 * letters / column numbers / corner select a whole row, column or plate. The modifiers arrive as
 * the raw mouse event because deciding what they mean is one rule that belongs in one place
 * (`usePlateSelection.ts`), not something each caller re-derives.
 */
export interface PlateGridSelection {
  /** Well indices currently selected. */
  selected: ReadonlySet<number>;
  onWellDown: (well: WellDefinition, e: MouseEvent) => void;
  /** Fires only mid-drag; the hook ignores it otherwise. */
  onWellEnter: (well: WellDefinition, e: MouseEvent) => void;
  onRowHead: (row: number, e: MouseEvent) => void;
  onColumnHead: (col: number, e: MouseEvent) => void;
  onAllHead: (e: MouseEvent) => void;
}

export function PlateViewer({
  plate,
  kind,
  sourceHint,
  toolbar,
  compact,
  selection,
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
  /** Present iff the plate is being edited — see {@link PlateGridSelection}. */
  selection?: PlateGridSelection;
}) {
  // Gated on `loaded` exactly as the cells are (see `WellCell`), so the legend lists the colors
  // actually on screen. Without the gate an unloaded well's configured sample type — often just
  // enum filler — added a swatch to the legend that no cell ever showed.
  const typesPresent = [...new Set(plate.wells.map((w) => (w.loaded ? w.sampleType : "empty")))];
  // The plate's fluors in optical-channel order (unknown channel last) — the chip order, and the
  // order the cell's lines are grouped from.
  const fluorOrder = [...plate.fluors].sort((a, b) =>
    a.channel === undefined
      ? b.channel === undefined
        ? 0
        : 1
      : b.channel === undefined
        ? -1
        : a.channel - b.channel,
  );
  // The row order every well cell follows: one line for the sample name, then one per *channel*
  // (see {@link fluorLine}), always at the same offset. A well that carries nothing on a given
  // channel leaves that line blank rather than pulling the ones below it up, so a column of cells
  // reads down its channels — Ch3's target is on the Ch3 line whether or not the well also has
  // Ch1. Reserving the same lines everywhere is also what makes every grid row the same height.
  const lines = [...new Set(fluorOrder.map((f) => fluorLine(f.fluor)))];

  // Keyed by the `WellDefinition` itself rather than by label: the grid already has the well in
  // hand at the point it hovers, and a Biomeme strip's positions are labelled by column alone.
  const { show, hide, node } = useHoverCard((well: WellDefinition) => wellCard(well, fluorOrder));

  /**
   * The grid takes focus when it is clicked, which is what makes the keyboard reach it.
   *
   * A well click cannot move focus on its own: the selection handlers call `preventDefault` to
   * stop a drag selecting the cells' text, and that suppresses the focus change too — so whatever
   * the user last typed in (an edit panel field, the add-a-dye box) kept focus for the rest of the
   * session. The editor's keyboard and clipboard handlers stand aside for a focused field, by
   * design, so Cmd-C, Cmd-V, Delete and the arrow keys all silently did nothing after the first
   * time a name was typed. Focusing the grid here is what ends that: the plate is what the user is
   * pointing at, so the plate is what the keystroke should reach.
   */
  const gridRef = useRef<HTMLTableElement>(null);

  return (
    <div
      className={
        "plateviewer" +
        (compact ? " plateviewer--compact" : "") +
        (selection ? " plateviewer--selectable" : "")
      }
    >
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
            {/* A mixed-vessel plate has no plate-level name — the wells each carry their own,
                so list what's actually in the block rather than showing a dash. */}
            <Pair k="Vessel" v={plateVesselLabel(plate) || "—"} />
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
            ref={gridRef}
            className="decoded__grid plate__grid mono"
            style={{ "--plate-fluor-rows": Math.max(1, lines.length) } as CSSProperties}
            // Focusable only while it is the thing being edited, and never in the tab order: it is
            // a click target that has to be able to hold focus, not a stop on the way through the
            // page. See `gridRef` above for why the click can't do this by itself.
            tabIndex={selection ? -1 : undefined}
            onMouseDown={selection ? () => gridRef.current?.focus({ preventScroll: true }) : undefined}
          >
            <thead>
              <tr>
                {/* The corner selects the whole plate while editing (a spreadsheet's own
                    convention, and Cmd-A's equivalent for the mouse); it is blank otherwise. */}
                <th
                  className={selection ? "plate__head plate__head--all" : undefined}
                  onMouseDown={selection ? (e) => selection.onAllHead(e) : undefined}
                  title={selection ? "Select every well" : undefined}
                />
                {Array.from({ length: plate.columns }, (_, c) => (
                  <th
                    key={c}
                    className={selection ? "plate__head" : undefined}
                    onMouseDown={selection ? (e) => selection.onColumnHead(c, e) : undefined}
                    title={selection ? `Select column ${c + 1}` : undefined}
                  >
                    {c + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROW_LABELS.slice(0, plate.rows).map((label, row) => (
                <tr key={label}>
                  {/* A single-row plate (e.g. a Biomeme run's synthesized strip of tube
                      positions — `biomeme.ts`) has no row to distinguish, so the header cell is
                      left blank rather than showing the redundant, always-"A" row letter. It is
                      still the row's select-all target while editing. */}
                  <th
                    className={selection ? "plate__head" : undefined}
                    onMouseDown={selection ? (e) => selection.onRowHead(row, e) : undefined}
                    title={selection ? `Select row ${label}` : undefined}
                  >
                    {plate.rows === 1 ? "" : label}
                  </th>
                  {Array.from({ length: plate.columns }, (_, col) => (
                    <WellCell
                      key={col}
                      well={plate.wells[row * plate.columns + col]!}
                      lines={lines}
                      fluorOrder={fluorOrder}
                      show={show}
                      hide={hide}
                      selection={selection}
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

/**
 * Which cell line a dye's target belongs on: **its colour, which is its channel.** The dye
 * palette *is* the channel palette (`fluorColors.ts`), so two dyes of one emission band — the
 * mixed-vessel plate's ROX and Tex 615, both Ch3 — already share a hue, and sharing a line falls
 * out of that with no channel lookup. Going through the colour rather than `PlateFluor.channel`
 * is also what makes a `.plt.csv` opened with no run beside it group the way the same plate does
 * inside its run: with no `.Dcal` to resolve dye names against, it states no channel at all.
 *
 * A dye the palette doesn't name has no band to share, so it keys on its own name and keeps its
 * own line — merging the unnamed ones would put two unrelated dyes on one.
 */
function fluorLine(fluor: string): string {
  return isKnownFluor(fluor) ? fluorColor(fluor) : fluor;
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
    // Only on a plate that states the vessel per well — otherwise the whole plate's plastic is
    // already named above the grid, and repeating it in all 96 cards says nothing.
    well.vessel ?? null,
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

/** One well: a line for the sample name, then one line per channel in `lines`, blank where this
 * well carries nothing on that channel — plus a row of channel-coloured dots, one per fluor
 * the well actually carries, which is all the compact variant has room for (the text lines are
 * hidden there). Everything the cell can't show — replicate, quantity, the full fluor→target
 * list — is one hover away in {@link wellCard}, which is why there's no click-through panel. */
function WellCell({
  well,
  lines,
  fluorOrder,
  show,
  hide,
  selection,
}: {
  well: WellDefinition;
  lines: string[];
  fluorOrder: PlateFluor[];
  show: (well: WellDefinition, el: HTMLElement) => void;
  hide: () => void;
  selection?: PlateGridSelection;
}) {
  const meta = SAMPLE_TYPE_META[well.sampleType];

  return (
    <td
      className={
        "plate__well" +
        (well.loaded ? "" : " is-empty") +
        (selection?.selected.has(well.index) ? " is-selected" : "")
      }
      style={well.loaded ? { background: meta.color + "22", borderColor: meta.color + "55" } : undefined}
      onMouseEnter={(e) => {
        show(well, e.currentTarget);
        selection?.onWellEnter(well, e);
      }}
      onMouseLeave={hide}
      onMouseDown={selection ? (e) => selection.onWellDown(well, e) : undefined}
    >
      {well.loaded && (
        <>
          {/* Always rendered, even unnamed: the empty line keeps the target list starting at the
              same height in every well, which is the point of the fixed row height. */}
          <span className="plate__wellsample">{well.sample}</span>
          <span className="plate__welltargets">
            {lines.map((line) => {
              // Blank, not skipped, when this well carries nothing on the channel: the line
              // belongs to the plate's channel, not to the well's Nth dye, so targets stay in
              // channel order down the cell no matter which dyes a given well happens to use.
              // Normally a well has at most one dye per line — an instrument cannot resolve two
              // dyes from one band — but a hand-authored plate can say otherwise, and the line
              // names both rather than hiding one.
              const here = well.fluors.filter((wf) => fluorLine(wf.fluor) === line);
              return (
                <span
                  key={line}
                  className="plate__target"
                  style={here[0] ? { color: fluorColor(here[0].fluor) } : undefined}
                >
                  {here.map((f) => f.target || f.fluor).join(" · ")}
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
