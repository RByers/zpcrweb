/**
 * Editing a {@link PlateDefinition} — the model half of the app's plate editor, the way
 * `protocolBuilder.ts` is the model half of its protocol editor.
 *
 * **Every function here is pure**: it takes a plate and returns a new one, sharing the wells it
 * didn't touch. Nothing in this module knows about selection, clipboards or the DOM; the UI owns
 * *which* wells an edit applies to, this module owns *what a plate is allowed to look like
 * afterwards*.
 *
 * Three invariants it exists to keep, all of which a naive in-place edit gets wrong:
 *
 * - **Derived fields follow the wells.** `loaded`, `dyeCount`, `targets` and `samples` are
 *   restatements of what the wells hold (`plateCsv.ts` rebuilds all four on read), so an edit
 *   that sets a target without updating `targets` produces a plate that disagrees with its own
 *   serialization. {@link normalizePlate} recomputes them after every edit.
 * - **A well is loaded iff it carries a fluor.** That is the `.plt.csv` rule (`pltcsv.md` §4),
 *   and since this editor's output round-trips through that format, adopting any other rule here
 *   would mean an edit that survives on screen but not through a save. Clearing a well's last
 *   fluor therefore empties the well.
 * - **The vessel is stated once** — on the plate or per well, never both (`pltcsv.md` §3.1);
 *   a file that does both is rejected on read. {@link normalizePlate} enforces the either-or:
 *   giving one well its own vessel pushes the plate's down onto all the others, and wells that
 *   all agree hoist back up to the plate.
 *
 * `sampleTypeRaw` is kept in step too ({@link SAMPLE_TYPE_TO_RAW}), except for an `other`-typed
 * well, whose raw code is the only record of what the source file actually said and is preserved
 * untouched unless the type itself is changed.
 */

import { byChannel, SAMPLE_TYPE_TO_RAW } from "./pltd.js";
import type { PlateDefinition, PlateFluor, SampleType, WellDefinition, WellFluor } from "./pltd.js";

/**
 * A change to one or more wells. **Every field is optional and "absent" means "leave alone"** —
 * which is what lets one edit set the sample across a column without disturbing the targets
 * already in it. `null` is the explicit clear, distinct from absent.
 */
export interface WellPatch {
  /** Sample name; `null` or `""` clears it. */
  sample?: string | null;
  sampleType?: SampleType;
  /** This well's own consumable type; `null` clears it (the plate's own then applies). */
  vessel?: string | null;
  replicate?: number | null;
  quantity?: number | null;
  /**
   * Per-fluor targets, keyed by dye name: a string sets the well's target for that dye (`""` =
   * in the well with no target, the `+` cell of `pltcsv.md` §4), `null` takes the dye out of the
   * well. Dyes not mentioned are left as they are.
   *
   * A dye the plate doesn't declare is added to the plate's fluor list by {@link editWells},
   * so pasting a well that carries a dye this plate lacks brings the dye with it.
   */
  fluors?: Record<string, string | null>;
}

/** Read a well back out as the patch that would recreate it — what a copy puts on the clipboard,
 * and the inverse of applying it to an empty well. Fluors are listed in the plate's own channel
 * order, so a pasted well's dyes land in the same order a parsed one's would. */
export function wellPatch(well: WellDefinition): WellPatch {
  const fluors: Record<string, string | null> = {};
  for (const f of well.fluors) fluors[f.fluor] = f.target ?? "";
  return {
    sample: well.sample ?? "",
    sampleType: well.sampleType,
    vessel: well.vessel ?? null,
    replicate: well.replicate ?? null,
    quantity: well.quantity ?? null,
    fluors,
  };
}

/** The patch that empties a well completely — the Delete key, and what "clear" means. Spelled as
 * a patch rather than a separate operation so it goes through the same normalization. */
export function clearPatch(plate: PlateDefinition): WellPatch {
  const fluors: Record<string, string | null> = {};
  for (const f of plate.fluors) fluors[f.fluor] = null;
  return {
    sample: null,
    sampleType: "empty",
    vessel: null,
    replicate: null,
    quantity: null,
    fluors,
  };
}

/** Apply one patch to every listed well (0-based plate indices; out-of-range ones are ignored). */
export function editWells(
  plate: PlateDefinition,
  indices: Iterable<number>,
  patch: WellPatch,
): PlateDefinition {
  const patches = new Map<number, WellPatch>();
  for (const i of indices) patches.set(i, patch);
  return applyWellPatches(plate, patches);
}

/**
 * Apply a different patch per well — what a paste of a multi-well block is. Any dye named by any
 * patch that the plate doesn't yet declare is added to the plate's fluor list first (with no
 * channel: a channel is a fact about the instrument's optics that no edit can invent — see
 * {@link PlateFluor.channel}).
 */
export function applyWellPatches(
  plate: PlateDefinition,
  patches: Map<number, WellPatch>,
): PlateDefinition {
  const known = new Set(plate.fluors.map((f) => f.fluor));
  const added: PlateFluor[] = [];
  for (const patch of patches.values()) {
    for (const [fluor, target] of Object.entries(patch.fluors ?? {})) {
      if (target === null || known.has(fluor)) continue;
      known.add(fluor);
      added.push({ fluor });
    }
  }
  const fluors = added.length ? [...plate.fluors, ...added].sort(byChannel) : plate.fluors;

  const wells = plate.wells.map((w) => {
    const patch = patches.get(w.index);
    return patch ? patchWell(w, patch) : w;
  });
  return normalizePlate({ ...plate, fluors, wells });
}

function patchWell(well: WellDefinition, patch: WellPatch): WellDefinition {
  const next: WellDefinition = { ...well };
  if (patch.sample !== undefined) next.sample = patch.sample || undefined;
  if (patch.vessel !== undefined) next.vessel = patch.vessel || undefined;
  if (patch.replicate !== undefined) next.replicate = patch.replicate ?? undefined;
  if (patch.quantity !== undefined) next.quantity = patch.quantity ?? undefined;
  if (patch.sampleType !== undefined && patch.sampleType !== well.sampleType) {
    next.sampleType = patch.sampleType;
    // An `other` well's raw code is the only record of what the file said; every other type has
    // a code of its own to write (see the module comment).
    next.sampleTypeRaw =
      patch.sampleType === "other" ? well.sampleTypeRaw : SAMPLE_TYPE_TO_RAW[patch.sampleType];
  }
  if (patch.fluors) {
    const byFluor = new Map(next.fluors.map((f) => [f.fluor, f]));
    for (const [fluor, target] of Object.entries(patch.fluors)) {
      if (target === null) {
        byFluor.delete(fluor);
        continue;
      }
      const existing = byFluor.get(fluor);
      const wf: WellFluor = { fluor, ...(existing?.channel !== undefined ? { channel: existing.channel } : {}) };
      if (target) wf.target = target;
      byFluor.set(fluor, wf);
    }
    next.fluors = [...byFluor.values()].sort(byChannel);
  }
  return next;
}

/**
 * Set the plate's dye list wholesale — the "fluors for the plate" control. Dyes dropped from the
 * list are taken out of every well that carried them (which can empty a well, per the module
 * comment); dyes added appear in the list with no well carrying them yet, which the format
 * represents perfectly well as an all-empty column.
 *
 * Channels are carried over from the plate's existing entry for a dye of the same name, since
 * nothing about editing a plate can discover one.
 */
export function setPlateFluors(plate: PlateDefinition, fluors: string[]): PlateDefinition {
  const seen = new Set<string>();
  const existing = new Map(plate.fluors.map((f) => [f.fluor, f]));
  const next: PlateFluor[] = [];
  for (const raw of fluors) {
    const fluor = raw.trim();
    if (!fluor || seen.has(fluor)) continue;
    seen.add(fluor);
    next.push(existing.get(fluor) ?? { fluor });
  }
  next.sort(byChannel);
  const wells = plate.wells.map((w) => {
    const kept = w.fluors.filter((f) => seen.has(f.fluor));
    return kept.length === w.fluors.length ? w : { ...w, fluors: kept };
  });
  return normalizePlate({ ...plate, fluors: next, wells });
}

/**
 * Recompute everything a plate says about itself that its wells already say — `loaded`,
 * `dyeCount`, `targets`, `samples` — and settle the vessel either-or (see the module comment).
 * Called by every edit above; exported because a caller that builds wells by hand needs the same
 * pass before serializing.
 */
export function normalizePlate(plate: PlateDefinition): PlateDefinition {
  const wells = plate.wells.map((w) => (w.loaded === w.fluors.length > 0 ? w : { ...w, loaded: w.fluors.length > 0 }));
  const targets: string[] = [];
  const samples: string[] = [];
  for (const w of wells) {
    for (const f of w.fluors) if (f.target && !targets.includes(f.target)) targets.push(f.target);
    if (w.sample && !samples.includes(w.sample)) samples.push(w.sample);
  }
  return normalizeVessels({
    ...plate,
    dyeCount: plate.fluors.length,
    targets,
    samples,
    wells,
  });
}

/**
 * The vessel either-or (`pltcsv.md` §3.1): the plate names the plastic, or the wells do, never
 * both — a file stating it twice is rejected on read, so an editor that let the two coexist would
 * write a plate it could not open again.
 *
 * - Some well names a vessel while the plate also does → the plate's name is pushed down onto
 *   every well that doesn't have one of its own, and the plate's is cleared. Nothing is lost:
 *   each well ends up saying exactly what it said before.
 * - Every well names the same vessel → hoisted back up to the plate, wells cleared. This is what
 *   makes "set the whole plate to BR White" come out as an ordinary single-vessel plate rather
 *   than 96 identical `Vessel` cells.
 */
function normalizeVessels(plate: PlateDefinition): PlateDefinition {
  const perWell = plate.wells.some((w) => w.vessel);
  if (!perWell) return plate;

  const distinct = new Set(plate.wells.map((w) => w.vessel ?? plate.plateName ?? ""));
  if (distinct.size === 1) {
    const only = [...distinct][0]!;
    return { ...plate, plateName: only, wells: plate.wells.map((w) => ({ ...w, vessel: undefined })) };
  }
  if (!plate.plateName) return plate;
  return {
    ...plate,
    plateName: "",
    wells: plate.wells.map((w) => (w.vessel ? w : { ...w, vessel: plate.plateName })),
  };
}

