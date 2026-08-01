/**
 * Stage a thermal protocol for a new run.
 *
 * Two halves, deliberately: a list of the app's loaded files on the left — this is the file bar
 * the Device view otherwise hides, brought back for the one job it's needed for here — and a
 * review of whatever that selects on the right. What is reviewed is the **ASCII run definition**
 * rather than a decoded step table, because that text is the artifact that would actually be sent
 * (`prcl.md` §3, and see `protocolSource.ts` for why the encrypted `.prcl` isn't the thing to
 * send). Reviewing anything other than the bytes that would leave the machine would be reviewing
 * the wrong object.
 *
 * Both action buttons are disabled and will stay that way until the library grows the commands
 * behind them — `CRCSENDFILE` and the §5 GUID upload sequence for one, `RemoteRun`/`PROCEED` for
 * the other (`usb.md` §10, "Not implemented"). They are present rather than omitted so the shape
 * of the flow is visible, and each says what it is waiting for.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { parseRunDefinitionText } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import {
  protocolCandidates,
  selectionFromCandidate,
  selectionFromText,
  type ProtocolSelection,
} from "../../lib/protocolSource";
import type { LoadedFile, PlateFileResult, RunResult } from "../../state/useZpcrStore";
import type { CfxDeviceHandle } from "../../state/useCfxDevice";

export function DeviceProtocol({
  device,
  files,
  runs,
  plateFiles,
  activeId,
}: {
  device: CfxDeviceHandle;
  files: LoadedFile[];
  runs: Map<string, RunResult>;
  plateFiles: Map<string, PlateFileResult>;
  /** The app's currently selected file, used as the initial pick when it has a protocol. */
  activeId: string | null;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<ProtocolSelection | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const candidates = useMemo(
    () => protocolCandidates(files, runs, plateFiles),
    [files, runs, plateFiles],
  );

  // Land on something reviewable without a click: the app's active file when it has a protocol,
  // else the first file that does. Re-runs when a file finishes decrypting, which is what turns
  // an unavailable row into a pickable one.
  useEffect(() => {
    if (uploaded) return;
    if (selectedId && candidates.some((c) => c.id === selectedId && !c.unavailable)) return;
    const active = candidates.find((c) => c.id === activeId && !c.unavailable);
    setSelectedId((active ?? candidates.find((c) => !c.unavailable))?.id ?? null);
  }, [candidates, activeId, selectedId, uploaded]);

  const selection: ProtocolSelection | null = useMemo(() => {
    if (uploaded) return uploaded;
    const c = candidates.find((x) => x.id === selectedId);
    return c ? selectionFromCandidate(c) : null;
  }, [uploaded, candidates, selectedId]);

  const loadTextFile = async (file: File) => {
    setUploadError(null);
    try {
      setUploaded(selectionFromText(file.name, parseRunDefinitionText(await file.text())));
      setSelectedId(null);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="device__panel">
      <div className="device__panelhead">
        <h2 className="device__paneltitle">Protocol for a new run</h2>
        <button className="btn btn--sm" onClick={() => fileInput.current?.click()}>
          Load .prcl.txt…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".txt,.prcl.txt,text/plain"
          // Classed rather than anonymous so `uitest` can target *this* input: the header's drop
          // zone carries the page's other `input[type=file]`, and a positional selector would
          // silently start loading protocols into the wrong one.
          className="devproto__input"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            // Clear the input so picking the same file twice still fires a change event.
            (e.target as HTMLInputElement).value = "";
            if (f) void loadTextFile(f);
          }}
        />
      </div>

      {uploadError && <div className="rail__note">Couldn't read that protocol: {uploadError}</div>}

      <div className="devproto">
        <div className="devproto__files">
          <div className="devproto__listtitle">Loaded runs</div>
          {candidates.length === 0 ? (
            <div className="device__empty mono">
              No files loaded. Open a run, or load a <code>.prcl.txt</code> above.
            </div>
          ) : (
            <ul className="devproto__list">
              {candidates.map((c) => (
                <li key={c.id}>
                  <button
                    className={
                      "devproto__file" +
                      (c.id === selectedId && !uploaded ? " is-active" : "") +
                      (c.unavailable ? " is-disabled" : "")
                    }
                    disabled={!!c.unavailable}
                    title={c.unavailable ?? `Use this run's protocol${c.protocolName ? `: ${c.protocolName}` : ""}`}
                    onClick={() => {
                      setSelectedId(c.id);
                      setUploaded(null);
                    }}
                  >
                    <span className="devproto__filename mono">{c.fileName}</span>
                    <span className="devproto__fileproto">
                      {c.unavailable ? "—" : c.protocolName || "(unnamed protocol)"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {uploaded && (
            <div className="devproto__uploaded">
              <span className="devproto__filename mono">{uploaded.label}</span>
              <span className="devproto__fileproto">loaded from disk</span>
            </div>
          )}
        </div>

        <div className="devproto__review">
          {!selection ? (
            <div className="device__empty mono">
              Select a run with an embedded protocol, or load a <code>.prcl.txt</code>.
            </div>
          ) : (
            <>
              <div className="devproto__reviewhead">
                <div className="devproto__label">{selection.label}</div>
                <div className="devproto__meta mono">
                  {[
                    Number.isFinite(selection.document.lidTemperatureC)
                      ? `lid ${selection.document.lidTemperatureC} °C`
                      : null,
                    Number.isFinite(selection.document.volumeUl)
                      ? `${selection.document.volumeUl} µL`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <ProtocolDecoded text={selection.runDefinition} />
              <div className="devproto__actions">
                <button
                  className="btn"
                  disabled
                  title={
                    "Not implemented yet: sending a file needs CRCSENDFILE and the upload " +
                    "sequence in usb.md §5, which this library doesn't have."
                  }
                >
                  Upload protocol
                </button>
                <button
                  className="btn btn--primary"
                  disabled
                  title={
                    "Not implemented yet: starting a run needs RemoteRun and PROCEED " +
                    "(usb.md §3), which this library doesn't have."
                  }
                >
                  Start run
                </button>
                {device.connection !== "connected" && (
                  <span className="devproto__hint mono">not connected</span>
                )}
              </div>
              <div className="rail__note device__footnote">
                Both buttons are inert: this client reads an instrument and retrieves files from
                it, and has no upload or run-control commands yet (<code>usb.md</code> §10).
                Reviewing and staging a protocol works; sending it does not.
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
