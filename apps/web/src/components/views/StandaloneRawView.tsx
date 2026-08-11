import { useMemo, useState } from "react";
import { hexDump, parsePltd, parsePrcl } from "@zpcrweb/core";
import { PasswordPrompt } from "../PasswordPrompt";
import { DownloadIcon } from "../DownloadIcon";
import { DecodedAlfFile } from "../raw/DecodedAlf";
import { usePltdPassword } from "../../state/pltdPassword";
import { downloadBytes } from "../../lib/download";
import { looksLikeXml, XmlTreeFromString } from "../../lib/xmlTree";
import { fileBytes, type LoadedFile } from "../../state/useZpcrStore";

type Mode = "decoded" | "text" | "hex";
const textDecoder = new TextDecoder("utf-8");

/**
 * The "Raw files" tab for a file that *is* one file — no `Zpcr` archive to browse, so no file
 * list beside the viewer: a slimmed-down `RawFilesView`. Used by the standalone `.pltd`/
 * `.plt.csv` plates, a `.prcl`/`.prcl.txt` protocol, a `.alf` run report, and a Biomeme run, whose
 * whole run export is a single JSON document (`biomeme.md`).
 *
 * `.pltd` and `.prcl` need the CFX password to decrypt into XML — the same container, so the same
 * prompt and the same tree (`zipcrypto.md`); `.plt.csv`, `.prcl.txt`, the report and the Biomeme
 * JSON are already plain UTF-8 and are shown verbatim — the point of a raw view is the bytes as
 * written, so nothing is re-indented or re-ordered on the way to the screen.
 *
 * A `.alf` also gets a **Decoded** mode, and opens on it, exactly as it does inside an archive
 * (`RawFilesView`): the report's own text is a `*`-delimited wall of numbers, so the file's raw
 * view without a decode beside it is the one place the app is *less* useful for a file it owns
 * than for the same file zipped up in a run. The other standalone kinds have no decoder to offer
 * here — a plate's is the Plates tab's, a protocol's the Protocol tab's — so for them the toggle
 * stays two buttons wide.
 */
export function StandaloneRawView({ file }: { file: LoadedFile }) {
  const [password, setPassword] = usePltdPassword();
  // The two encrypted containers this view opens (`zipcrypto.md`), which behave identically here:
  // the bytes on disk are a ZIP nobody can read, and the "text" the raw view has to offer is the
  // XML payload inside it. A `.prcl.txt` is not one of these — it is already the text.
  const isPltd = file.kind === "pltd";
  const isPrcl = file.kind === "prcl";
  const encrypted = isPltd || isPrcl;
  const isAlf = file.kind === "alf";
  const [mode, setMode] = useState<Mode>(isAlf ? "decoded" : "text");
  const [limit, setLimit] = useState(4096);
  // Names the text tab for what it holds, the same way the encrypted pair's says "XML" — a Biomeme
  // run's one entry is a JSON document, and "Text" undersells it next to the Decoded views
  // elsewhere.
  const textLabel = encrypted ? "XML" : file.kind === "biomeme" ? "JSON" : "Text";

  // Never an archive held open (`fileContent.ts`) — a standalone plate/protocol/Biomeme file is
  // its bytes — so this is the file itself, not a zip of anything.
  const bytes = fileBytes(file);
  // The payload of whichever encrypted container this is, or null for the plain-text kinds. Both
  // parsers report `needsPassword`/`error` rather than throwing, which is what the prompt below
  // reads; a bare-text `.prcl` (`prcl.md` §1.1) has no XML and falls through to the plain dump.
  const payload = useMemo(() => {
    if (isPltd) return parsePltd(bytes, password ? { password } : undefined);
    if (isPrcl) return parsePrcl(bytes, password ? { password } : undefined);
    return null;
  }, [isPltd, isPrcl, bytes, password]);
  // The payload's XML when there is a container to open, the bytes themselves when there isn't —
  // the plain-text kinds, and the bare-text `.prcl` variant, which decodes with no XML and nothing
  // to prompt for.
  const text =
    !encrypted || (payload && !payload.xml && !payload.needsPassword && !payload.error)
      ? textDecoder.decode(bytes)
      : payload?.xml;
  const size = bytes.length;

  return (
    <div className="raw raw--solo">
      <section className="raw__viewer">
        <div className="raw__toolbar">
          <span className="raw__fname mono">{file.name}</span>
          <span className="raw__size mono">{size.toLocaleString()} B</span>
          <div className="segmented segmented--sm raw__modes">
            {isAlf && (
              <button
                className={"segmented__item" + (mode === "decoded" ? " is-active" : "")}
                onClick={() => setMode("decoded")}
              >
                Decoded
              </button>
            )}
            <button
              className={"segmented__item" + (mode === "text" ? " is-active" : "")}
              onClick={() => setMode("text")}
              disabled={encrypted && !text}
              title={encrypted ? "Decrypted XML" : ""}
            >
              {textLabel}
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
            onClick={() => downloadBytes(file.name, bytes)}
            aria-label="Download"
            title="Download original file"
          >
            <DownloadIcon />
          </button>
        </div>

        {mode === "decoded" && isAlf && text ? (
          <div className="raw__decoded">
            <DecodedAlfFile text={text} />
          </div>
        ) : mode === "text" && encrypted && (payload?.needsPassword || payload?.error) ? (
          <div className="raw__decoded">
            <PasswordPrompt wrong={!!payload.error} onSubmit={setPassword} />
          </div>
        ) : mode === "text" && text && looksLikeXml(text) ? (
          // A `.pltd`'s or `.prcl`'s decrypted payload: the same collapsible tree the in-archive
          // viewers use. A `.plt.csv` isn't XML and falls through to the plain dump below.
          <div className="raw__decoded">
            <XmlTreeFromString xml={text} />
          </div>
        ) : mode === "text" ? (
          <pre className="raw__dump mono">{text}</pre>
        ) : (
          <>
            <pre className="raw__dump mono">{hexDump(bytes, { maxBytes: limit })}</pre>
            {limit < size && (
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
