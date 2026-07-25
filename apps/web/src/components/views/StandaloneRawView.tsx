import { useMemo, useState } from "react";
import { hexDump, parsePltd } from "@zpcrweb/core";
import { PasswordPrompt } from "../PasswordPrompt";
import { DownloadIcon } from "../DownloadIcon";
import { usePltdPassword } from "../../state/pltdPassword";
import { downloadBytes } from "../../lib/download";
import type { LoadedFile } from "../../state/useZpcrStore";

type Mode = "text" | "hex";
const textDecoder = new TextDecoder("utf-8");

/** The "Raw files" tab for a standalone `.pltd`/`.plt.csv` top-level entry: just this one
 * file's own bytes, no `Zpcr`/archive involved — a slimmed-down `RawFilesView`. `.pltd` needs
 * the CFX password to decrypt into XML; `.plt.csv` is already plain UTF-8 text. */
export function StandaloneRawView({ file }: { file: LoadedFile }) {
  const [password, setPassword] = usePltdPassword();
  const [mode, setMode] = useState<Mode>("text");
  const [limit, setLimit] = useState(4096);
  const isPltd = file.kind === "pltd";

  const pltd = useMemo(
    () => (isPltd ? parsePltd(file.bytes, password ? { password } : undefined) : null),
    [isPltd, file.bytes, password],
  );
  const text = isPltd ? pltd?.xml : textDecoder.decode(file.bytes);
  const size = file.bytes.length;

  return (
    <div className="raw raw--solo">
      <section className="raw__viewer">
        <div className="raw__toolbar">
          <span className="raw__fname mono">{file.name}</span>
          <span className="raw__size mono">{size.toLocaleString()} B</span>
          <div className="segmented segmented--sm raw__modes">
            <button
              className={"segmented__item" + (mode === "text" ? " is-active" : "")}
              onClick={() => setMode("text")}
              disabled={isPltd && !text}
              title={isPltd ? "Decrypted XML" : ""}
            >
              {isPltd ? "XML" : "Text"}
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
            onClick={() => downloadBytes(file.name, file.bytes)}
            aria-label="Download"
            title="Download original file"
          >
            <DownloadIcon />
          </button>
        </div>

        {mode === "text" && isPltd && (pltd?.needsPassword || pltd?.error) ? (
          <div className="raw__decoded">
            <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
          </div>
        ) : mode === "text" ? (
          <pre className="raw__dump mono">{text}</pre>
        ) : (
          <>
            <pre className="raw__dump mono">{hexDump(file.bytes, { maxBytes: limit })}</pre>
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
