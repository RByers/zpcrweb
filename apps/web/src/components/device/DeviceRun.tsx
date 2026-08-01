/**
 * The run that would be started: its thermal protocol and its plate map, side by side.
 *
 * Both halves come from the file bar above — this panel renders a selection it does not own (see
 * `state/useRunStaging.ts` for the rules, and `lib/protocolSource.ts` for how a selection becomes
 * these two values). That split is deliberate: the bar is the app's existing file list doing its
 * normal job, and staging a run is just a second thing a chip can mean.
 *
 * What is shown for the protocol is the **ASCII run definition**, not a decoded step table,
 * because that text is the artifact that would actually be sent (`prcl.md` §3). Reviewing anything
 * other than the bytes that would leave the machine would be reviewing the wrong object — and it
 * makes a `.prcl.txt` and a run's embedded protocol render identically, since by then they are
 * the same thing.
 *
 * The one thing this panel *owns* rather than renders is the run's name: unlike the protocol and
 * the plate, it comes from neither file — no Bio-Rad format has a field for it (see
 * `experiment.ts` in `@zpcrweb/core`), so for a run that doesn't exist yet there is nowhere to
 * read it from and someone has to type it. It sits here, with the rest of what the run is made
 * of, rather than in the rail beside the button that would send it.
 *
 * There is no "start" button here: it lives in the rail with the other commands that actuate the
 * instrument (see `DeviceRail`), because that is what it is.
 */
import { ProtocolDecoded } from "../raw/DecodedView";
import { PlateViewer } from "../plate/PlateViewer";
import type { StagedRun } from "../../lib/protocolSource";

/** A half's heading: what it is, and which file it came from. */
function PartHead({
  title,
  sourceName,
  overridden,
}: {
  title: string;
  sourceName: string | null;
  overridden: boolean;
}) {
  return (
    <div className="devrun__parthead">
      <span className="devrun__parttitle">{title}</span>
      {sourceName && (
        <span className="devrun__source mono" title={sourceName}>
          {sourceName}
          {/* Only worth saying when it *is* an override: otherwise the file name alone already
              answers "from where?", and every heading would carry a redundant badge. */}
          {overridden && <span className="devrun__badge">override</span>}
        </span>
      )}
    </div>
  );
}

export function DeviceRun({
  staged,
  name,
  onNameChange,
}: {
  staged: StagedRun;
  /** The run's name, as typed. Held by {@link DeviceView} — it outlives this panel's renders and
   * is what a future Start run would label the run with. */
  name: string;
  onNameChange: (name: string) => void;
}) {
  const { protocol, plate } = staged;
  const empty = !protocol.value && !plate.value && !protocol.reason && !plate.reason;
  // A run can be staged alongside overrides of *both* halves, in which case it supplies neither
  // — but it is still the instrument the plate's dyes were read on, which is what gives a
  // `.plt.csv` its channels. Say so, or its chip is lit for no reason a reader can see.
  const instrumentOnly = !!staged.runName && protocol.overridden && plate.overridden;

  return (
    <section className="device__panel">
      <div className="device__panelhead">
        <h2 className="device__paneltitle">Run to start</h2>
        <span className="devrun__hint mono">
          {empty
            ? "select files above"
            : instrumentOnly && staged.runName
              ? `instrument: ${staged.runName}`
              : "a run supplies both halves; a .prcl.txt or .plt.csv overrides one"}
        </span>
      </div>

      {/* Shown even with nothing staged: naming the run is a thing you can do before choosing
          its parts, and hiding the field would make the panel look like it had one job. */}
      <label className="devrun__name">
        <span className="devrun__namelabel">Experiment name</span>
        <input
          className="devrun__nameinput"
          value={name}
          onChange={(e) => onNameChange(e.currentTarget.value)}
          spellCheck={false}
          placeholder={protocol.value?.document.name || "unnamed run"}
          title={
            "What to call this run. The instrument's own formats have no field for a run name " +
            "(see zpcrweb-json.md), so this is what the app records alongside the results."
          }
        />
      </label>

      {empty ? (
        <div className="device__empty mono">
          Nothing staged. Select a run in the bar above, or a <code>.prcl.txt</code> and a{" "}
          <code>.plt.csv</code> to build one from parts.
        </div>
      ) : (
        <div className="devrun">
          <div className="devrun__part">
            <PartHead
              title="Protocol"
              sourceName={protocol.sourceName}
              overridden={protocol.overridden}
            />
            {protocol.value ? (
              <>
                <div className="devrun__meta mono">
                  {[
                    Number.isFinite(protocol.value.document.lidTemperatureC)
                      ? `lid ${protocol.value.document.lidTemperatureC} °C`
                      : null,
                    Number.isFinite(protocol.value.document.volumeUl)
                      ? `${protocol.value.document.volumeUl} µL`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <ProtocolDecoded text={protocol.value.runDefinition} />
              </>
            ) : (
              <div className="device__empty mono">
                {protocol.reason ?? "No protocol selected."}
              </div>
            )}
          </div>

          <div className="devrun__part">
            <PartHead title="Plate" sourceName={plate.sourceName} overridden={plate.overridden} />
            {staged.channelsFrom && (
              <div className="devrun__meta mono">channels from {staged.channelsFrom}</div>
            )}
            {plate.value ? (
              <PlateViewer plate={plate.value} compact />
            ) : (
              <div className="device__empty mono">{plate.reason ?? "No plate selected."}</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
