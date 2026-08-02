import { Fragment, useEffect, useMemo, useState } from "react";
import { fileKindDescription, parseRunDefinition } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { RenameIcon } from "../RenameIcon";
import { formatCompactDateTime } from "../../lib/experiment";
import type { LoadedFile } from "../../state/useZpcrStore";

/**
 * The Overview tab for a `.prcl.txt` loaded on its own — a thermal protocol with no run around
 * it (`protocol.md`).
 *
 * A protocol file used to have no view at all: it existed only to be staged, so selecting one
 * dropped you on the Instrument view whatever tab you were on. But it is a document in its own
 * right — the thing you'd want to read before sending it to an instrument, or after pulling it
 * off one — and reading it is exactly what the annotated listing makes possible. So the same
 * {@link ProtocolDecoded} a run's Overview uses renders it here, under the same info table every
 * other kind's Overview leads with (`OverviewView`, `StandalonePlateOverviewView`), and
 * Instrument stays where it is *used*.
 *
 * Everything shown is `parseRunDefinition`'s (core) plus the file's own name/mtime: this
 * component picks rows out of the decoded program and counts directives, but reads nothing out
 * of the text itself.
 */
export function StandaloneProtocolView({
  file,
  runDefinition,
  onRenameFile,
}: {
  file: LoadedFile;
  runDefinition: string;
  /** Rename the loaded file (`ZpcrStore.renameFile`) — a `.prcl.txt` has no separate "name" the
   * way a `.zpcr` does (see `OverviewView`'s `onRename`), so this is the only identity it has to
   * edit. */
  onRenameFile: (name: string) => void;
}) {
  const program = useMemo(() => parseRunDefinition(runDefinition), [runDefinition]);
  const reads = program.directives.filter((d) => d.verb === "PLATEREAD").length;

  // Toggled by the toolbar's Rename button — turns the "Filename" info row into an editable
  // field, in place, the same commit-on-blur/Enter/Escape-reverts pattern `OverviewView` uses.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(file.name);
  useEffect(() => setDraft(file.name), [file.name]);
  const commit = () => {
    setRenaming(false);
    const next = draft.trim();
    if (!next || next === file.name) {
      setDraft(file.name);
      return;
    }
    onRenameFile(next);
  };

  const infoRows = [
    { label: "Type", value: fileKindDescription(file.kind) },
    {
      label: "Filename",
      value: renaming ? (
        <input
          className="overview__filename-input mono"
          value={draft}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(file.name);
              setRenaming(false);
            }
          }}
          aria-label="Filename"
          spellCheck={false}
        />
      ) : (
        file.name
      ),
    },
    { label: "Last modified", value: formatCompactDateTime(new Date(file.lastModified)) },
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
        <div className="overview__toolbar">
          <button
            className="raw__download overview__renamebtn"
            onClick={() => setRenaming(true)}
            aria-label={`Rename ${file.name}`}
            title="Rename this file"
          >
            <RenameIcon />
          </button>
        </div>
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
