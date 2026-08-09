import { useState, type ReactNode } from "react";
import { SAMPLE_TYPES, type PlateDefinition, type SampleType, type WellDefinition, type WellPatch } from "@zpcrweb/core";
import { fluorColor } from "../../lib/fluorColors";
import { SAMPLE_TYPE_META } from "../../lib/sampleType";
import type { PlateSelection } from "./usePlateSelection";

/**
 * The edit mode's right-hand panel: what the selected wells hold, and the fields that change it.
 *
 * **One field per fact, across the whole selection.** A field shows the selected wells' shared
 * value, or `‹mixed›` when they disagree — and typing into it sets that one fact on every selected
 * well while leaving everything else alone. That is what makes the column gesture work: select
 * column 1, type a sample name, and twelve wells get the sample without their targets moving (see
 * `WellPatch`, whose absent-means-leave-alone rule this panel is the UI for).
 *
 * The **dye list is plate-level** and sits at the bottom, separated from the per-well fields,
 * because it is the one control here that isn't about the selection: adding a dye gives the plate
 * a channel every well can carry, and removing one takes it out of every well at once.
 *
 * Edits are applied as they are typed, not on a Save — see `PlateEditor`, which persists them the
 * same way the protocol editor does.
 */
export function PlateEditPanel({
  plate,
  selection,
  onPatch,
  onClear,
  onFluors,
}: {
  plate: PlateDefinition;
  selection: PlateSelection;
  /** Apply one patch to every selected well. */
  onPatch: (patch: WellPatch) => void;
  /** Empty the selected wells. */
  onClear: () => void;
  /** Replace the plate's dye list. */
  onFluors: (fluors: string[]) => void;
}) {
  const wells = selection.wells;
  const some = wells.length > 0;

  return (
    <aside className="plateedit__panel" aria-label="Selected wells">
      <div className="plateedit__panelhead">
        <h3 className="decoded__h">{selectionLabel(wells)}</h3>
        {some && (
          <button type="button" className="btn btn--sm" onClick={onClear} title="Empty the selected wells (Delete)">
            Clear
          </button>
        )}
      </div>

      {!some ? (
        <p className="decoded__hint">
          Click a well to select it. Click a row letter or column number for the whole row or
          column; Cmd/Ctrl-click adds to the selection, Shift-click extends it, and dragging sweeps
          a block out. Cmd/Ctrl-C and -V copy and paste wells — including to and from a
          spreadsheet.
        </p>
      ) : (
        <>
          <Field label="Sample" title="The sample loaded in these wells">
            <input
              className="plateedit__input mono"
              value={commonOf(wells, (w) => w.sample ?? "") ?? ""}
              placeholder={commonOf(wells, (w) => w.sample ?? "") === undefined ? MIXED : "none"}
              spellCheck={false}
              onChange={(e) => onPatch({ sample: e.currentTarget.value })}
              aria-label="Sample name for the selected wells"
            />
          </Field>

          <Field label="Sample type" title="What kind of reaction these wells hold">
            <select
              className="plateedit__input mono"
              value={commonOf(wells, (w) => w.sampleType) ?? ""}
              onChange={(e) => onPatch({ sampleType: e.currentTarget.value as SampleType })}
              aria-label="Sample type for the selected wells"
            >
              {commonOf(wells, (w) => w.sampleType) === undefined && <option value="">{MIXED}</option>}
              {SAMPLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SAMPLE_TYPE_META[t].label}
                </option>
              ))}
            </select>
          </Field>

          {/* The plastic, per well — the one thing a `.plt.csv` can say that no CFX format can
              (see `pltcsv.md` §3.1), which is why it is offered here at all. Left blank, the
              plate's own vessel applies. */}
          <Field label="Vessel" title="The plastic these wells sit in — BR Clear, BR White, …">
            <input
              className="plateedit__input mono"
              value={commonOf(wells, (w) => w.vessel ?? plate.plateName) ?? ""}
              placeholder={commonOf(wells, (w) => w.vessel ?? plate.plateName) === undefined ? MIXED : "unstated"}
              spellCheck={false}
              list="plateedit-vessels"
              onChange={(e) => onPatch({ vessel: e.currentTarget.value })}
              aria-label="Vessel for the selected wells"
            />
            <datalist id="plateedit-vessels">
              {VESSELS.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </Field>

          <div className="plateedit__section">
            <div className="plateedit__sectionhead">Targets</div>
            {plate.fluors.length === 0 ? (
              <p className="decoded__hint">This plate has no dyes yet — add one below.</p>
            ) : (
              plate.fluors.map((f) => {
                const inWell = commonOf(wells, (w) => w.fluors.some((wf) => wf.fluor === f.fluor));
                const target = commonOf(
                  wells,
                  (w) => w.fluors.find((wf) => wf.fluor === f.fluor)?.target ?? "",
                );
                return (
                  <div key={f.fluor} className="plateedit__fluorrow">
                    <label className="plateedit__fluorname" title={`Load ${f.fluor} into the selected wells`}>
                      <input
                        type="checkbox"
                        checked={inWell === true}
                        ref={(el) => {
                          // Mixed presence is neither checked nor unchecked, and only the DOM
                          // property can say so.
                          if (el) el.indeterminate = inWell === undefined;
                        }}
                        onChange={(e) =>
                          onPatch({ fluors: { [f.fluor]: e.currentTarget.checked ? (target ?? "") : null } })
                        }
                        aria-label={`${f.fluor} in the selected wells`}
                      />
                      <span className="decoded__swatch" style={{ background: fluorColor(f.fluor) }} />
                      <span className="mono">{f.fluor}</span>
                    </label>
                    <input
                      className="plateedit__input mono"
                      value={target ?? ""}
                      placeholder={target === undefined ? MIXED : inWell ? "no target" : "not loaded"}
                      spellCheck={false}
                      // Typing a target loads the dye into the well: naming what is being measured
                      // and saying the dye is there are the same act.
                      onChange={(e) => onPatch({ fluors: { [f.fluor]: e.currentTarget.value } })}
                      aria-label={`${f.fluor} target for the selected wells`}
                    />
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <PlateFluorList plate={plate} onFluors={onFluors} />
    </aside>
  );
}

/** What the panel shows where a field's wells disagree — and what a field left at this value
 * leaves alone. Spelled with guillemets so it can't be mistaken for a sample actually named
 * "mixed". */
const MIXED = "‹mixed›";

/** The consumables a CFX block is loaded with, offered as completions rather than as a closed
 * list: the vessel is a free string that has to match a `.Dcal`'s plate field, and a plate may
 * legitimately name one this app has never seen. */
const VESSELS = ["BR Clear", "BR White", "MJ White"];

/** The plate's dye list — plate-level, not per-well: these are the columns every well can carry
 * (`pltcsv.md` §4). Removing one takes it out of every well, which is why it asks first. */
function PlateFluorList({
  plate,
  onFluors,
}: {
  plate: PlateDefinition;
  onFluors: (fluors: string[]) => void;
}) {
  const [adding, setAdding] = useState("");
  const names = plate.fluors.map((f) => f.fluor);

  const add = () => {
    const name = adding.trim();
    if (!name || names.includes(name)) return;
    onFluors([...names, name]);
    setAdding("");
  };

  return (
    <div className="plateedit__section">
      <div className="plateedit__sectionhead" title="The dyes this plate is read in">
        Plate dyes
      </div>
      <div className="plate__fluors plate__fluors--inline">
        {names.map((fluor) => (
          <span key={fluor} className="plate__chip mono">
            <span className="decoded__swatch" style={{ background: fluorColor(fluor) }} />
            {fluor}
            <button
              type="button"
              className="plateedit__chipx"
              title={`Remove ${fluor} from the plate and from every well`}
              aria-label={`Remove ${fluor} from the plate`}
              onClick={() => {
                const wellsWith = plate.wells.filter((w) => w.fluors.some((f) => f.fluor === fluor)).length;
                if (
                  wellsWith > 0 &&
                  !window.confirm(
                    `Remove ${fluor} from the plate? It is loaded in ${wellsWith} well${wellsWith === 1 ? "" : "s"}, and will be taken out of each of them.`,
                  )
                ) {
                  return;
                }
                onFluors(names.filter((n) => n !== fluor));
              }}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="plateedit__addrow">
        <input
          className="plateedit__input mono"
          value={adding}
          placeholder="add a dye — e.g. FAM"
          spellCheck={false}
          onChange={(e) => setAdding(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-label="Add a dye to the plate"
        />
        <button type="button" className="btn btn--sm" onClick={add} disabled={!adding.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

function Field({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <label className="plateedit__field" title={title}>
      <span className="plateedit__label">{label}</span>
      {children}
    </label>
  );
}

/**
 * The value every selected well shares, or `undefined` when they disagree — the whole of the
 * `‹mixed›` rule, in one place so every field reads the same way.
 */
function commonOf<T>(wells: WellDefinition[], read: (w: WellDefinition) => T): T | undefined {
  if (wells.length === 0) return undefined;
  const first = read(wells[0]!);
  return wells.every((w) => read(w) === first) ? first : undefined;
}

/** `3 wells · A1–A3` — the count, plus the range when the selection is a simple run, so the panel
 * says what it is pointed at without listing 96 labels. */
function selectionLabel(wells: WellDefinition[]): string {
  if (wells.length === 0) return "No wells selected";
  if (wells.length === 1) return `Well ${wells[0]!.label}`;
  return `${wells.length} wells · ${wells[0]!.label}–${wells[wells.length - 1]!.label}`;
}
