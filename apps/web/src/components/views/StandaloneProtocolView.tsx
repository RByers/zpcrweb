import { useMemo } from "react";
import { fileKindDescription, parseRunDefinition } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a `.prcl.txt` loaded on its own — a thermal protocol with no run around
 * it (`protocol.md`).
 *
 * A protocol file used to have no view at all: it existed only to be staged, so selecting one
 * dropped you on the Instrument view whatever tab you were on. But it is a document in its own
 * right — the thing you'd want to read before sending it to an instrument, or after pulling it
 * off one — and reading it is exactly what the annotated listing makes possible. So the same
 * {@link ProtocolDecoded} a run's Overview uses renders it here, under the same stat tiles a run
 * gets, and Instrument stays where it is *used*.
 *
 * Everything shown is `parseRunDefinition`'s (core): this component picks tiles out of the
 * decoded program and counts directives, but reads nothing out of the text itself.
 */
export function StandaloneProtocolView({
  file,
  runDefinition,
}: {
  file: LoadedFile;
  runDefinition: string;
}) {
  const program = useMemo(() => parseRunDefinition(runDefinition), [runDefinition]);
  const reads = program.directives.filter((d) => d.verb === "PLATEREAD").length;

  const tiles = [
    { label: "Type", value: fileKindDescription(file.kind) },
    { label: "Method", value: program.method ?? "—" },
    {
      label: "Lid",
      value: program.lidTemperatureC != null ? `${program.lidTemperatureC} °C` : "—",
    },
    { label: "Volume", value: program.volumeUl != null ? `${program.volumeUl} µL` : "—" },
    { label: "Steps", value: String(program.steps.length) },
    { label: "Plate reads", value: reads === 0 ? "none (not real-time)" : String(reads) },
    {
      // The mask is the plate's, not the protocol's — an authored file always says "all six"
      // whatever the run will measure (`usb.md` §3.1), so this reports what the file says
      // rather than what the instrument would do.
      label: "Scan",
      value: program.scanMasks.map((m) => m.summary).join(" · ") || "—",
    },
  ];

  return (
    <div className="overview">
      <div className="overview__head">
        <section className="overview__tiles">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile__label">{t.label}</div>
              <div className="tile__value mono">{t.value}</div>
            </div>
          ))}
        </section>
      </div>

      <section className="overview__block">
        <div className="overview__blockhead">
          <h2 className="overview__h">Thermal protocol</h2>
        </div>
        <span className="decoded__hint mono">
          {file.name} — the pure text run definition. Stage it against a plate on the Instrument
          tab.
        </span>
        <ProtocolDecoded text={runDefinition} />
      </section>
    </div>
  );
}
