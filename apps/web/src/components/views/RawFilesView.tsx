import { useMemo, useRef, useState } from "react";
import {
  USB_TRAFFIC_TEXT_NAME,
  ZPCRWEB_SETTINGS_NAME,
  formatUsbTrafficBytes,
  formatZpcrwebSettings,
  hexDump,
  isUsbTrafficName,
  parsePltd,
  parsePrcl,
  type Zpcr,
} from "@zpcrweb/core";
import { DecodedView, decodedKind } from "../raw/DecodedView";
import { PlateXml } from "../raw/DecodedPlate";
import { ProtocolXml } from "../raw/DecodedProtocol";
import { looksLikeXml, XmlTreeFromString } from "../../lib/xmlTree";
import { usePltdPassword } from "../../state/pltdPassword";
import { zpcrwebFromAnalysis } from "../../state/analysisSettings";
import type { FileSettings } from "../../state/useZpcrStore";
import { decodedToCsv, downloadText, plateReadCsvFilename, plateReadToCsv } from "../../lib/download";
import { DownloadIcon } from "../DownloadIcon";

/** Drop the archive entry's extension, e.g. "RunInfo.xml" -> "RunInfo". */
function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

type Mode = "decoded" | "text" | "hex";

function group(name: string): string {
  if (name === ZPCRWEB_SETTINGS_NAME) return "Analysis";
  if (/\.Plateread$/i.test(name)) return "Plate reads";
  if (/\.pltd$/i.test(name) || /\.plt\.csv$/i.test(name)) return "Plate setup";
  if (/\.prcl$/i.test(name)) return "Protocol";
  if (/\.Dcal$/i.test(name)) return "Calibration";
  // The USB traffic log — `usb-traffic.bin`, or the plain-text `usb-traffic.log` of a `.zpcr`
  // written before the binary format (`usb-traffic.md`). Not instrument output, but the same kind
  // of thing as the rest of Metadata: an account of what happened, beside `RunInfo.xml`/`.alf`.
  if (isUsbTrafficName(name)) return "Metadata";
  if (/\.(xml|txt|alf)$/i.test(name)) return "Metadata";
  return "Other";
}

const GROUP_ORDER = [
  "Metadata",
  "Analysis",
  "Plate setup",
  "Protocol",
  "Plate reads",
  "Calibration",
  "Other",
];
// `.plt.csv` is zpcrweb's own plate CSV format (see `plateCsv.ts`) — plain UTF-8 text, no
// decryption needed, unlike `.pltd`/`.prcl`. `zpcrweb.json` is likewise our own (`zpcrweb-json.md`),
// as is `usb-traffic.log`, the plain-text log older `.zpcr` files carry.
const TEXTUAL = /\.(xml|txt|alf|json|log|plt\.csv)$/i;

/** Best default mode for a file: decoded if a decoder exists, else text for text, else hex.
 *
 * `usb-traffic.bin` is the one entry that is binary and yet opens in **Text**: its stored form is
 * records, and the text is what a reader wants — this view is where that rendering happens
 * (`formatUsbTrafficBytes`, `usb-traffic.md` §4). It gets no *Decoded* mode, because the text
 * already is the decode: one line per message, with the payload bytes on it. */
function defaultMode(name: string): Mode {
  if (decodedKind(name)) return "decoded";
  if (TEXTUAL.test(name) || isUsbTrafficName(name)) return "text";
  return "hex";
}

/**
 * `zpcrweb.json` as it stands *right now*, which is deliberately not what the loaded archive
 * holds.
 *
 * Analysis settings live in React state for the session and are written back into the archive
 * bytes in IndexedDB by `analysisPersist.ts` at most once a minute — so the entry inside the
 * bytes this view parsed is, in general, either absent (a file straight off the instrument, or
 * one whose first edit hasn't flushed yet) or a minute stale. Showing that would show the user
 * settings nothing is actually being analyzed with. So the entry is synthesized from live state
 * with the same serializer the writer uses (`formatZpcrwebSettings`), which makes it byte-identical
 * to what `exportBytes` puts in a downloaded copy.
 *
 * The one field that legitimately differs is `updatedAt`, stamped at write time — this renders
 * "now" rather than the timestamp of the last flush.
 */
function liveSettingsText(settings: FileSettings): string {
  return formatZpcrwebSettings(zpcrwebFromAnalysis(settings));
}

export function RawFilesView({ zpcr, settings }: { zpcr: Zpcr; settings: FileSettings }) {
  // The live document, not the archive's copy — see `liveSettingsText`. Recomputed whenever an
  // analysis setting changes, so the view tracks a threshold drag as it happens.
  const settingsText = useMemo(() => liveSettingsText(settings), [settings]);
  const settingsBytes = useMemo(() => new TextEncoder().encode(settingsText), [settingsText]);

  const entries = useMemo(
    () =>
      zpcr.archive.entries.includes(ZPCRWEB_SETTINGS_NAME)
        ? zpcr.archive.entries
        : // A file that has never been saved with settings still gets the row: the settings
          // exist (as defaults), they are what the run is being analyzed with, and they are what
          // a download would carry.
          [...zpcr.archive.entries, ZPCRWEB_SETTINGS_NAME],
    [zpcr],
  );

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const name of entries) {
      const g = group(name);
      (map.get(g) ?? map.set(g, []).get(g)!).push(name);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({
      group: g,
      names: map.get(g)!,
    }));
  }, [entries]);

  const [selected, setSelected] = useState<string>(
    () => zpcr.archive.entries.find((n) => /RunInfo\.xml$/i.test(n)) ?? zpcr.archive.entries[0] ?? "",
  );
  const [mode, setMode] = useState<Mode>(() => defaultMode(selected));
  const [limit, setLimit] = useState(4096);

  // Reset to the file's best default mode whenever the selection changes. Done *during* render
  // (React's "adjusting state when state changes" pattern) rather than in an effect: an effect
  // runs after the commit, so the newly selected file would first paint a frame in the previous
  // file's mode — picking `runlog.xml` while `RunInfo.xml` was in Text mode would flash its XML
  // before snapping back to the decoded table. React discards this render and re-runs the
  // component immediately, so nothing intermediate reaches the DOM.
  const [modeFor, setModeFor] = useState(selected);
  if (modeFor !== selected) {
    setModeFor(selected);
    setMode(defaultMode(selected));
    setLimit(4096);
  }

  // `.pltd`/`.prcl` are usually binary (an encrypted ZIP), but their "Text" view is the
  // decrypted XML payload (or, for a plaintext `.prcl`, the raw runDefinition — see prcl.md
  // §1.1, handled inside <ProtocolXml> itself).
  const isPltd = /\.pltd$/i.test(selected);
  const isPrcl = /\.prcl$/i.test(selected);
  const isSettings = selected === ZPCRWEB_SETTINGS_NAME;
  // The binary traffic log: textual in the sense that matters here (there is a text rendering of
  // it), just one this view generates rather than reads. The plain-text `usb-traffic.log` of an
  // older `.zpcr` is already covered by TEXTUAL and needs none of this.
  const isTrafficLog = isUsbTrafficName(selected) && !TEXTUAL.test(selected);
  const isTextual = TEXTUAL.test(selected) || isPltd || isPrcl || isTrafficLog;
  const hasDecoded = decodedKind(selected) !== null;
  const size = !selected ? 0 : isSettings ? settingsBytes.length : zpcr.archive.bytes(selected).length;

  const rawBody = useMemo(() => {
    if (!selected || mode === "decoded") return "";
    if (mode === "text" && (isPltd || isPrcl)) return ""; // rendered via <PlateXml>/<ProtocolXml>
    if (isSettings) {
      return mode === "text" ? settingsText : hexDump(settingsBytes, { maxBytes: limit });
    }
    if (mode === "text" && isTrafficLog) return formatUsbTrafficBytes(zpcr.archive.bytes(selected));
    if (mode === "text" && isTextual) return zpcr.archive.text(selected);
    return zpcr.archive.hexDump(selected, { maxBytes: limit });
  }, [
    zpcr,
    selected,
    mode,
    limit,
    isTextual,
    isTrafficLog,
    isPltd,
    isPrcl,
    isSettings,
    settingsText,
    settingsBytes,
  ]);

  // What "Text"/"XML" mode is currently showing, for the download button — re-derives the
  // decrypted payload independently of <PlateXml>/<ProtocolXml> (same pattern those components
  // already use themselves), since neither exposes its decoded XML string upward.
  const [password] = usePltdPassword();
  const textDownload = useMemo(() => {
    if (mode !== "text" || !selected) return null;
    if (isSettings) return { content: settingsText, ext: "json" };
    if (isPltd) {
      const pltd = parsePltd(zpcr.archive.bytes(selected), password ? { password } : undefined);
      return pltd.xml ? { content: pltd.xml, ext: "xml" } : null;
    }
    if (isPrcl) {
      const prcl = parsePrcl(zpcr.archive.bytes(selected), password ? { password } : undefined);
      if (prcl.container.format === "text") {
        return prcl.protocol ? { content: prcl.protocol.runDefinition, ext: "txt" } : null;
      }
      return prcl.xml ? { content: prcl.xml, ext: "xml" } : null;
    }
    if (isTextual) return { content: rawBody, ext: "txt" };
    return null;
  }, [mode, selected, isPltd, isPrcl, isSettings, isTextual, zpcr, password, rawBody, settingsText]);


  const decodedRef = useRef<HTMLDivElement>(null);
  const canDownload = mode === "decoded" ? hasDecoded : textDownload !== null;

  const handleDownload = () => {
    if (mode === "decoded") {
      if (decodedKind(selected) === "plateread") {
        const read = zpcr.reads.find((r) => r.fileName === selected);
        if (read) downloadText(plateReadCsvFilename(zpcr, read), plateReadToCsv(read), "text/csv");
        return;
      }
      if (!decodedRef.current) return;
      downloadText(`${baseName(selected)}.csv`, decodedToCsv(decodedRef.current), "text/csv");
    } else if (textDownload) {
      // The traffic log downloads under the name its text form has everywhere else — the console's
      // own button writes exactly the same file (`USB_TRAFFIC_TEXT_NAME`), not `usb-traffic.bin`.
      const name = isTrafficLog
        ? USB_TRAFFIC_TEXT_NAME
        : isPltd || isPrcl
          ? `${baseName(selected)}.${textDownload.ext}`
          : selected;
      const mime =
        textDownload.ext === "xml"
          ? "application/xml"
          : textDownload.ext === "json"
            ? "application/json"
            : "text/plain";
      downloadText(name, textDownload.content, mime);
    }
  };

  return (
    <div className="raw">
      <aside className="raw__list">
        {groups.map((g) => (
          <div className="raw__group" key={g.group}>
            <div className="raw__grouphead">{g.group}</div>
            {g.names.map((name) => (
              <button
                key={name}
                className={"raw__item mono" + (name === selected ? " is-active" : "")}
                onClick={() => setSelected(name)}
                title={name}
              >
                {name}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="raw__viewer">
        <div className="raw__toolbar">
          <span className="raw__fname mono">{selected}</span>
          <span className="raw__size mono">{size.toLocaleString()} B</span>
          <div className="segmented segmented--sm raw__modes">
            <button
              className={"segmented__item" + (mode === "decoded" ? " is-active" : "")}
              onClick={() => setMode("decoded")}
              disabled={!hasDecoded}
              title={hasDecoded ? "" : "No decoder for this file"}
            >
              Decoded
            </button>
            <button
              className={"segmented__item" + (mode === "text" ? " is-active" : "")}
              onClick={() => setMode("text")}
              disabled={!isTextual}
              title={
                isPltd || isPrcl
                  ? "Decrypted XML"
                  : isTrafficLog
                    ? "The recorded messages, one line each"
                    : isTextual
                      ? ""
                      : "Binary file — hex only"
              }
            >
              {isPltd || isPrcl ? "XML" : "Text"}
            </button>
            <button
              className={"segmented__item" + (mode === "hex" ? " is-active" : "")}
              onClick={() => setMode("hex")}
            >
              Hex
            </button>
          </div>
          <button
            className="raw__download"
            onClick={handleDownload}
            disabled={!canDownload}
            aria-label="Download"
            title={mode === "decoded" ? "Download table as CSV" : "Download as a file"}
          >
            <DownloadIcon />
          </button>
        </div>

        {mode === "decoded" ? (
          <div className="raw__decoded" ref={decodedRef}>
            <DecodedView zpcr={zpcr} name={selected} />
          </div>
        ) : mode === "text" && isPltd ? (
          <div className="raw__decoded">
            <PlateXml zpcr={zpcr} name={selected} />
          </div>
        ) : mode === "text" && isPrcl ? (
          <div className="raw__decoded">
            <ProtocolXml zpcr={zpcr} name={selected} />
          </div>
        ) : mode === "text" && looksLikeXml(rawBody) ? (
          // Any other XML entry — `RunInfo.xml`, `runlog.xml`, `GlobData.xml` — gets the same
          // collapsible tree as the decrypted `.pltd`/`.prcl` payloads above, rather than the
          // flat dump `<pre>` that the remaining (genuinely plain-text) entries use.
          <div className="raw__decoded">
            <XmlTreeFromString xml={rawBody} />
          </div>
        ) : (
          <>
            <pre className="raw__dump mono">{rawBody}</pre>
            {mode === "hex" && limit < size && (
              <button className="raw__more" onClick={() => setLimit((l) => l + 8192)}>
                Show more ({(size - limit).toLocaleString()} B remaining)
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
