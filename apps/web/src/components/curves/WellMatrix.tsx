import { useState } from "react";
import type { SampleType } from "@zpcrweb/core";
import { wellKey } from "../../state/useZpcrStore";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import { useHoverCard, type HoverCardData } from "./HoverCard";

interface Props {
  /** Plate size — an 8×12 CFX block by default, but arbitrary: a Biomeme run's synthesized
   * plate (`biomeme.ts`) is a single row of as few as 3 tube positions. See {@link
   * cellLabel} for how a single-row plate's cells are labelled differently from a real grid's. */
  rows?: number;
  cols?: number;
  enabled: Set<string>;
  onChange: (next: Set<string>) => void;
  /** Sample type per well key, from the plate definition — colors each cell to match the
   * Plates view (grey/empty, green/positive control, red/negative control, blue/unknown, …).
   * Omitted when no plate is loaded yet, in which case cells fall back to the plain on/off look. */
  wellTypes?: Map<string, SampleType>;
  /** Lowest Cq per well, over the well's positive curves — the ones that crossed their threshold.
   * A well listed here is marked with a `+` in its own sample-type color (red for an NTC, and so
   * on) so the mark reads as part of the cell rather than as a separate legend, and faded by
   * {@link plusOpacity} so an early, strongly-positive well stands out from a late marginal one.
   * Wells with no positive curve are simply absent. */
  positiveWells?: Map<string, number>;
  /** Hovering part of the grid (`null` on leave) — drives the curve-chart highlight. A cell
   * sends its own label; a row or column header sends every label in that row/column, so
   * hovering "A" or "3" isolates the whole line of wells exactly as hovering one cell isolates
   * one well. Labels, not row/col pairs, because that is what a curve carries — see {@link
   * cellLabel}. */
  onHoverWells?: (labels: string[] | null) => void;
  /** Double-clicking a well cell — isolates it: only this well stays enabled. */
  onSoloWell?: (row: number, col: number) => void;
  /** Hover-card content for a well's label (see {@link cellLabel}), or `null`/undefined to show
   * none. */
  cardData?: (label: string) => HoverCardData | null | undefined;
}

/** Cq at or below which a well's `+` is drawn at full strength. */
const CQ_BRIGHT = 20;
/** Cq by which it has faded to {@link OPACITY_DIM} — past here a positive is late and weak. */
const CQ_DIM = 30;
/** Cq at and beyond which it sits at {@link OPACITY_FAINT}, barely above the cell background. */
const CQ_FAINT = 35;
const OPACITY_DIM = 0.35;
const OPACITY_FAINT = 0.12;

/**
 * How strongly to draw a well's `+`, from its lowest Cq: a well that crossed its threshold early
 * carries far more signal than one that scraped across at cycle 38, and the grid should show that
 * at a glance rather than reading every positive alike. Full strength at Cq ≤ 20, faded to
 * {@link OPACITY_DIM} by 30 and to {@link OPACITY_FAINT} at 35 and beyond, linear in between.
 */
function plusOpacity(cq: number): number {
  if (!Number.isFinite(cq) || cq <= CQ_BRIGHT) return 1;
  if (cq >= CQ_FAINT) return OPACITY_FAINT;
  if (cq <= CQ_DIM) {
    const t = (cq - CQ_BRIGHT) / (CQ_DIM - CQ_BRIGHT);
    return 1 + t * (OPACITY_DIM - 1);
  }
  const t = (cq - CQ_DIM) / (CQ_FAINT - CQ_DIM);
  return OPACITY_DIM + t * (OPACITY_FAINT - OPACITY_DIM);
}

/**
 * A well's display label: the normal `"A1"`-style row-letter-plus-column for a real multi-row
 * plate, or — when the plate has only one row (a Biomeme run's synthesized single strip of tube
 * positions, `biomeme.ts`) — just the column number. A row that can never vary tells the user
 * nothing a bare position number doesn't already say more plainly; the row is still internally 0
 * ("row A") either way, since {@link wellKey} and every selection/highlight callback here work
 * in row/col, never in this display string. Mirrors `packages/core/src/biomeme.ts`'s
 * `singleRowAwareLabel`, which labels the same synthesized plate's `WellDefinition`/`WellCurve`
 * the same way — the two have to agree, since a hover label from here is matched against a
 * curve's own `wellLabel` field elsewhere in the Curves view.
 */
function cellLabel(row: number, col: number, rows: number): string {
  return rows === 1 ? String(col + 1) : `${String.fromCharCode(65 + row)}${col + 1}`;
}

/**
 * Plate selection grid, sized to the run's actual plate (8×12 for a CFX block by default; an
 * arbitrary, possibly single-row, shape for a Biomeme run — see {@link Props.rows}/`cols`).
 * Cells toggle a single well; the row and column headers toggle a whole row/column (the row
 * header is omitted for a single-row plate — see {@link cellLabel}); the corner toggles all
 * wells. Hovering follows the same grain as clicking: a cell highlights its own well, a header
 * highlights every well it would toggle. The reference row is shown separately, in the
 * Reference view.
 */
export function WellMatrix({
  rows = 8,
  cols = 12,
  enabled,
  onChange,
  wellTypes,
  positiveWells,
  onHoverWells,
  onSoloWell,
  cardData,
}: Props) {
  const { show, hide, node } = useHoverCard(cardData ?? (() => null));
  const singleRow = rows === 1;
  /** Well keys the pointer is over as a group, i.e. the row or column whose header is hovered.
   * A cell marks itself with CSS `:hover`; a header sits outside the cells it covers, so which
   * ones it lights up has to be tracked here. */
  const [peek, setPeek] = useState<Set<string> | null>(null);
  const sampleKeys = () => {
    const keys: string[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) keys.push(wellKey(r, c));
    return keys;
  };

  const toggleWell = (r: number, c: number) => {
    const next = new Set(enabled);
    const k = wellKey(r, c);
    next.has(k) ? next.delete(k) : next.add(k);
    onChange(next);
  };

  const rowKeys = (r: number) => Array.from({ length: cols }, (_, c) => wellKey(r, c));
  const colKeys = (c: number) => Array.from({ length: rows }, (_, r) => wellKey(r, c));
  const rowLabels = (r: number) => Array.from({ length: cols }, (_, c) => cellLabel(r, c, rows));
  const colLabels = (c: number) => Array.from({ length: rows }, (_, r) => cellLabel(r, c, rows));

  /** Hover handlers for a header, over the same wells its click would toggle. */
  const groupHover = (keys: string[], labels: string[]) => ({
    onMouseEnter: () => {
      setPeek(new Set(keys));
      onHoverWells?.(labels);
    },
    onMouseLeave: () => {
      setPeek(null);
      onHoverWells?.(null);
    },
  });

  const toggleGroup = (keys: string[]) => {
    const allOn = keys.every((k) => enabled.has(k));
    const next = new Set(enabled);
    for (const k of keys) (allOn ? next.delete(k) : next.add(k));
    onChange(next);
  };

  const toggleAll = () => {
    const keys = sampleKeys();
    const allOn = keys.every((k) => enabled.has(k));
    const next = new Set(enabled);
    for (const k of keys) (allOn ? next.delete(k) : next.add(k));
    onChange(next);
  };

  const renderRow = (r: number) => (
    <div className="wm-row" key={`row${r}`} style={{ display: "contents" }}>
      {/* Still occupies the grid's row-header column — dropping the element entirely would shift
          every cell after it into that column instead (CSS grid auto-placement has no gap to
          leave) — but a single-row plate's one row has nothing for a letter to distinguish, so
          it's left unlabelled rather than showing the redundant "A" (see `cellLabel`). Same
          click behavior either way: toggling the plate's only row is the same as the corner's
          "toggle all", so there's nothing misleading about leaving it live. */}
      <button
        className="wm-head"
        onClick={() => toggleGroup(rowKeys(r))}
        {...groupHover(rowKeys(r), rowLabels(r))}
        title={singleRow ? "Toggle all wells" : `Toggle row ${String.fromCharCode(65 + r)}`}
      >
        {singleRow ? "" : String.fromCharCode(65 + r)}
      </button>
      {Array.from({ length: cols }, (_, c) => {
        const key = wellKey(r, c);
        const on = enabled.has(key);
        const type = wellTypes?.get(key);
        const meta = type ? SAMPLE_TYPE_META[type] : undefined;
        const minCq = positiveWells?.get(key);
        const label = cellLabel(r, c, rows);
        // The `+` takes the cell's border color, dimmed alongside it when the well is off, so a
        // positive NTC reads red and a positive unknown blue without needing a legend.
        const borderColor = meta ? meta.color + (on ? "" : "66") : undefined;
        return (
          <button
            key={`w${r}-${c}`}
            className={"wm-cell" + (on ? " is-on" : "") + (peek?.has(key) ? " is-peek" : "")}
            style={
              meta
                ? {
                    borderColor,
                    background: meta.color + (on ? "40" : "16"),
                    boxShadow: on ? `0 0 6px ${meta.color}66` : undefined,
                  }
                : undefined
            }
            onClick={() => toggleWell(r, c)}
            onDoubleClick={() => onSoloWell?.(r, c)}
            onMouseEnter={(e) => {
              onHoverWells?.([label]);
              show(label, e.currentTarget);
            }}
            onMouseLeave={() => {
              onHoverWells?.(null);
              hide();
            }}
            aria-pressed={on}
            aria-label={
              [
                `Well ${label}`,
                meta?.label,
                minCq != null ? `positive, Cq ${minCq.toFixed(1)}` : null,
              ]
                .filter(Boolean)
                .join(" — ")
            }
            // Native tooltip only as a fallback: when a hover card is wired up it already names
            // the well and its sample type, and the two floating boxes fight each other.
            title={!cardData && meta ? `${label} — ${meta.label}` : undefined}
          >
            {/* Drawn rather than typed: a "+" glyph sits on the text baseline with its own
                side/vertical bearings, so it never centers in a cell this small however the line
                box is aligned. Two strokes on a square viewBox center exactly. */}
            {minCq != null && (
              <svg
                className="wm-cell__plus"
                viewBox="0 0 12 12"
                aria-hidden="true"
                style={{ color: borderColor, opacity: plusOpacity(minCq) }}
              >
                <path
                  d="M6 2v8M2 6h8"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="wellmatrix" style={{ ["--cols" as string]: cols }}>
      <button className="wm-corner" onClick={toggleAll} title="Toggle all wells">
        ⊕
      </button>
      {Array.from({ length: cols }, (_, c) => (
        <button
          key={`col${c}`}
          className="wm-head"
          onClick={() => toggleGroup(colKeys(c))}
          {...groupHover(colKeys(c), colLabels(c))}
          title={`Toggle column ${c + 1}`}
        >
          {c + 1}
        </button>
      ))}

      {Array.from({ length: rows }, (_, r) => renderRow(r))}
      {node}
    </div>
  );
}
