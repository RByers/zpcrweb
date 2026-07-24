import { useMemo, useState } from "react";
import { parsePltd, type Pltd, type SampleType, type WellDefinition, type Zpcr } from "@zpcrweb/core";
import { channelColor } from "../../lib/channelColors";
import { formatXml } from "../../lib/xmlFormat";
import { usePltdPassword } from "../../state/pltdPassword";

/** Display metadata per normalized sample type: short badge, full label, accent color. */
const SAMPLE_TYPE_META: Record<SampleType, { abbr: string; label: string; color: string }> = {
  unknown: { abbr: "Unk", label: "Unknown", color: "#8aa0c0" },
  standard: { abbr: "Std", label: "Standard", color: "#22d3ee" },
  ntc: { abbr: "NTC", label: "NTC (no-template)", color: "#ef4444" },
  nrt: { abbr: "NRT", label: "NRT (no-RT)", color: "#f97316" },
  positiveControl: { abbr: "Pos", label: "Positive control", color: "#22c55e" },
  negativeControl: { abbr: "Neg", label: "Negative control", color: "#a855f7" },
  empty: { abbr: "·", label: "Empty / not loaded", color: "#5a6b86" },
  passiveRef: { abbr: "Ref", label: "Passive reference", color: "#3b82f6" },
  custom: { abbr: "Cus", label: "Custom", color: "#eab308" },
  other: { abbr: "?", label: "Other", color: "#8aa0c0" },
};

const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** Decode a `.pltd` with the client-stored password, exposing the setter for the prompt. */
function usePltdEntry(
  zpcr: Zpcr,
  name: string,
): { pltd: Pltd; password: string; setPassword: (v: string) => void } {
  const [password, setPassword] = usePltdPassword();
  const pltd = useMemo(
    () => parsePltd(zpcr.archive.bytes(name), password ? { password } : undefined),
    [zpcr, name, password],
  );
  return { pltd, password, setPassword };
}

/** Prompt to enter the CFX plate-file password (stored client-side, reused for all plates). */
function PasswordPrompt({
  wrong,
  onSubmit,
}: {
  wrong: boolean;
  onSubmit: (pw: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <section className="decoded__block">
      <h3 className="decoded__h">Plate password required</h3>
      <p className="decoded__hint mono">
        {wrong ? "The saved password did not decrypt this file. " : ""}
        Plate files are ZipCrypto-encrypted; this app doesn&apos;t ship the password. Enter the
        CFX plate-file password (see <code>pltd.md</code> for how to find it in a licensed CFX
        Manager install). It&apos;s stored in your browser and reused for every plate.
      </p>
      <form
        className="plate__pwform"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onSubmit(value);
        }}
      >
        <input
          type="password"
          className="plate__pwinput mono"
          placeholder="plate-file password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit" className="segmented__item" disabled={!value}>
          Save &amp; decode
        </button>
      </form>
    </section>
  );
}

/** The ZIP container facts — shown alongside the password prompt when the payload is locked. */
function UndecodedNote({ pltd }: { pltd: Pltd }) {
  const c = pltd.container;
  return (
    <section className="decoded__block">
      <h3 className="decoded__h">Container</h3>
      <dl className="decoded__dl mono">
        <Pair k="Inner name" v={c.innerName} />
        <Pair
          k="Compression"
          v={c.compressionMethod === 9 ? "DEFLATE64" : c.compressionMethod === 8 ? "DEFLATE" : String(c.compressionMethod)}
        />
        <Pair k="Encrypted" v={c.encrypted ? "yes (ZipCrypto)" : "no"} />
        <Pair k="Sizes" v={`${c.compressedSize} → ${c.uncompressedSize} B`} />
      </dl>
    </section>
  );
}

/**
 * Decoded plate map for a `.pltd` file: an 8×12 grid coloured by sample type, each well
 * showing its loaded fluorophores (channel dots); click a well for its full detail
 * (fluors → targets, sample, condition, replicate, quantity). The decrypted `<platesetup2>`
 * XML is available separately via the Raw files "Text" mode (see {@link PlateXml}).
 */
export function DecodedPlate({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const { pltd, setPassword } = usePltdEntry(zpcr, name);
  const [selected, setSelected] = useState<number | null>(null);

  if (pltd.needsPassword || pltd.error) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
        <UndecodedNote pltd={pltd} />
      </div>
    );
  }
  if (!pltd.plate) return <div className="decoded__na mono">No plate for {name}.</div>;
  const { plate, container } = pltd;

  const typesPresent = [...new Set(plate.wells.map((w) => w.sampleType))];

  return (
    <div className="decoded">
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
              {f.fluor} <span className="plate__chipch">C{f.channel + 1}</span>
            </span>
          ))}
        </div>
        <span className="decoded__hint mono">
          {container.innerName} · {container.compressionMethod === 9 ? "DEFLATE64" : "DEFLATE"} ·
          decrypted
        </span>
      </section>

      <section className="decoded__block">
        <div className="decoded__gridwrap">
          <table className="decoded__grid plate__grid mono">
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

      {selected !== null && plate.wells[selected] && <WellDetail well={plate.wells[selected]} />}
    </div>
  );
}

/** The decrypted `<platesetup2>` XML, pretty-printed (Raw files "Text" mode for `.pltd`). */
export function PlateXml({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const { pltd, setPassword } = usePltdEntry(zpcr, name);
  const xml = pltd.xml ?? "";
  const formatted = useMemo(() => (xml ? formatXml(xml) : null), [xml]);
  if (pltd.needsPassword || pltd.error) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
        <UndecodedNote pltd={pltd} />
      </div>
    );
  }
  if (!xml) return <div className="decoded__na mono">No XML for {name}.</div>;
  if (formatted == null) return <pre className="decoded__xml mono">{xml}</pre>;
  return <div className="decoded__xml mono">{formatted}</div>;
}

function WellCell({
  well,
  selected,
  onClick,
}: {
  well: WellDefinition;
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
      className={"plate__well" + (well.loaded ? "" : " is-empty") + (selected ? " is-sel" : "")}
      style={well.loaded ? { background: meta.color + "22", borderColor: meta.color + "55" } : undefined}
      title={title}
      onClick={onClick}
    >
      <span className="plate__welltype" style={{ color: meta.color }}>
        {well.loaded ? meta.abbr : ""}
      </span>
      <span className="plate__dots">
        {well.fluors.map((f) => (
          <span key={f.channel} className="plate__dot" style={{ background: channelColor(f.channel) }} />
        ))}
      </span>
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
                <td>C{f.channel + 1}</td>
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
