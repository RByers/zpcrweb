import { useState } from "react";
import type { PlateDefinition, WellDefinition } from "@zpcrweb/core";
import { channelColor, channelLabel } from "../../lib/channelColors";
import { ROW_LABELS, SAMPLE_TYPE_META } from "../../lib/sampleType";

/**
 * The visual plate map for any {@link PlateDefinition}: an 8×12 grid coloured by sample type,
 * each well showing its loaded fluorophores (channel dots); click a well for its full detail
 * (fluors → targets, sample, condition, replicate, quantity). Used both by the "Plates" tab
 * (for a `.zpcr`'s embedded `.pltd` entries) and a `.pcrd`'s already-decrypted `plateSetup2`
 * subtree — same component either way, only the source of the {@link PlateDefinition} differs.
 */
type CellMode = "compact" | "detailed";

export function PlateViewer({ plate, sourceHint }: { plate: PlateDefinition; sourceHint?: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [cellMode, setCellMode] = useState<CellMode>("detailed");
  const typesPresent = [...new Set(plate.wells.map((w) => w.sampleType))];

  return (
    <div className="plateviewer">
      <div className="plateviewer__main">
        <section className="decoded__block">
          <h3 className="decoded__h">
            {plate.plateName || "Plate"} — {plate.rows}×{plate.columns}, {plate.dyeCount}{" "}
            {plate.dyeCount === 1 ? "dye" : "dyes"}
          </h3>
          <dl className="decoded__dl mono">
            <Pair k="Scan mode" v={plate.scanMode || "—"} />
            <Pair k="Plate type" v={plate.plateType || "—"} />
            <Pair k="Std units" v={plate.standardUnits || "—"} />
            <Pair k="Targets" v={plate.targets.length ? plate.targets.join(", ") : "—"} />
          </dl>
          <div className="plate__fluors">
            {plate.fluors.map((f) => (
              <span key={f.channel + f.fluor} className="plate__chip mono">
                <span className="decoded__swatch" style={{ background: channelColor(f.channel) }} />
                {f.fluor} <span className="plate__chipch">{channelLabel(f.channel)}</span>
              </span>
            ))}
          </div>
          {sourceHint && <span className="decoded__hint mono">{sourceHint}</span>}
        </section>

        <section className="decoded__block">
          <div className="decoded__controls">
            <div className="segmented segmented--sm">
              <button
                className={"segmented__item" + (cellMode === "compact" ? " is-active" : "")}
                onClick={() => setCellMode("compact")}
              >
                Compact
              </button>
              <button
                className={"segmented__item" + (cellMode === "detailed" ? " is-active" : "")}
                onClick={() => setCellMode("detailed")}
              >
                Detailed
              </button>
            </div>
          </div>

          <div className="decoded__gridwrap">
            <table
              className={
                "decoded__grid plate__grid mono" +
                (cellMode === "detailed" ? " plate__grid--detailed" : "")
              }
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
                    <th>{label}</th>
                    {Array.from({ length: plate.columns }, (_, col) => {
                      const w = plate.wells[row * plate.columns + col]!;
                      return (
                        <WellCell
                          key={col}
                          well={w}
                          mode={cellMode}
                          selected={selected === w.index}
                          onClick={() => setSelected(w.index)}
                        />
                      );
                    })}
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

      {selected !== null && plate.wells[selected] && (
        <div className="plateviewer__detail">
          <WellDetail well={plate.wells[selected]} />
        </div>
      )}
    </div>
  );
}

function WellCell({
  well,
  mode,
  selected,
  onClick,
}: {
  well: WellDefinition;
  mode: CellMode;
  selected: boolean;
  onClick: () => void;
}) {
  const meta = SAMPLE_TYPE_META[well.sampleType];
  const title = [
    well.label,
    meta.label,
    well.sampleName && `Sample: ${well.sampleName}`,
    well.condition && `Condition: ${well.condition}`,
    well.condition2 && well.condition2,
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
      className={
        "plate__well" +
        (mode === "detailed" ? " plate__well--detailed" : "") +
        (well.loaded ? "" : " is-empty") +
        (selected ? " is-sel" : "")
      }
      style={well.loaded ? { background: meta.color + "22", borderColor: meta.color + "55" } : undefined}
      title={title}
      onClick={onClick}
    >
      {mode === "compact" ? (
        <>
          <span className="plate__welltype" style={{ color: meta.color }}>
            {well.loaded ? meta.abbr : ""}
          </span>
          <span className="plate__dots">
            {well.fluors.map((f) => (
              <span key={f.channel} className="plate__dot" style={{ background: channelColor(f.channel) }} />
            ))}
          </span>
        </>
      ) : (
        well.loaded && (
          <>
            {well.condition && <span className="plate__wellcond">{well.condition}</span>}
            <span className="plate__welltargets">
              {well.fluors.map((f) => (
                <span key={f.channel} className="plate__target" style={{ color: channelColor(f.channel) }}>
                  {f.target || f.fluor}
                </span>
              ))}
            </span>
          </>
        )
      )}
    </td>
  );
}

function WellDetail({ well }: { well: WellDefinition }) {
  const meta = SAMPLE_TYPE_META[well.sampleType];
  return (
    <section className="decoded__block">
      <h3 className="decoded__h">
        Well {well.label} — {meta.label}
        {well.sampleTypeRaw ? ` (${well.sampleTypeRaw})` : ""}
      </h3>
      <dl className="decoded__dl mono">
        <Pair k="Loaded" v={well.loaded ? "yes" : "no (empty tube)"} />
        {well.sampleName && <Pair k="Sample" v={well.sampleName} />}
        {well.condition && <Pair k="Condition" v={well.condition} />}
        {well.condition2 && <Pair k="Condition 2" v={well.condition2} />}
        {well.replicate !== undefined && <Pair k="Replicate" v={String(well.replicate)} />}
        {well.quantity !== undefined && <Pair k="Quantity" v={String(well.quantity)} />}
      </dl>
      {well.fluors.length > 0 && (
        <table className="decoded__tbl mono">
          <thead>
            <tr>
              <th>Fluor</th>
              <th>Channel</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {well.fluors.map((f) => (
              <tr key={f.channel}>
                <td>
                  <span className="decoded__swatch" style={{ background: channelColor(f.channel) }} />
                  {f.fluor}
                </td>
                <td>{channelLabel(f.channel)}</td>
                <td>{f.target ?? <span className="decoded__empty">∅</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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
