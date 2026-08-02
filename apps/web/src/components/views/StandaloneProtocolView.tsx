import { Fragment, useMemo } from "react";
import { parseRunDefinition } from "@zpcrweb/core";
import { ProtocolEditor } from "../protocol/ProtocolEditor";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Protocol tab for a `.prcl.txt` loaded on its own — a thermal protocol with no run around
 * it (`protocol.md`). Overview, for this file kind, is a minimal filename card
 * ({@link StandaloneProtocolOverview}, which carries the `Type`/`Filename`/`Last modified` rows
 * every other kind's Overview leads with, and the rename control — see `OverviewView`'s
 * `onRenameFile`); this tab is where the protocol's own content lives.
 *
 * A protocol file used to have no view at all: it existed only to be staged, so selecting one
 * dropped you on the Instrument view whatever tab you were on. But it is a document in its own
 * right — the thing you'd want to read before sending it to an instrument, or after pulling it
 * off one — and reading it is exactly what the annotated listing makes possible. So the same
 * {@link ProtocolDecoded} a run's Protocol tab uses renders it here, under the same stat tiles a
 * run gets, and Instrument stays where it is *used*.
 *
 * Everything shown is `parseRunDefinition`'s (core): this component picks rows out of the
 * decoded program and counts directives, but reads nothing out of the text itself.
 *
 * It is also the one place a protocol can be *changed*. A `.prcl.txt` is this project's own
 * portable protocol form (`prcl.md` §3.1) — a file you'd author, not just read — so the listing
 * doubles as an editor ({@link ProtocolEditor}), and only here: every other carrier of the same
 * text is a record of a run that happened, which there would be no honest way to edit.
 */
export function StandaloneProtocolView({
  file,
  runDefinition,
  onChangeProtocol,
}: {
  file: LoadedFile;
  runDefinition: string;
  /** Persist an edited protocol back into the file — the store's `setProtocolText`. */
  onChangeProtocol: (runDefinition: string) => void;
}) {
  const program = useMemo(() => parseRunDefinition(runDefinition), [runDefinition]);
  const reads = program.directives.filter((d) => d.verb === "PLATEREAD").length;

  const infoRows = [
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
        <dl className="overview__dl overview__infotable mono">
          {infoRows.map((r) => (
            <Fragment key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <ProtocolEditor
        runDefinition={runDefinition}
        onChange={onChangeProtocol}
        fileName={file.name}
      />
    </div>
  );
}
