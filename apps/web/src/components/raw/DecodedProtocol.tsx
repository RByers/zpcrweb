import { useMemo } from "react";
import { parsePrcl, type Prcl, type ProtocolDocument, type Zpcr } from "@zpcrweb/core";
import { usePltdPassword } from "../../state/pltdPassword";
import { PasswordPrompt } from "../PasswordPrompt";
import { ProtocolDecoded } from "./DecodedView";
import { ProtocolStepsTable } from "./ProtocolSteps";
import { XmlTreeFromString } from "../../lib/xmlTree";

/** Decode a `.prcl` with the client-stored password (shared with `.pltd`/`.pcrd`, see
 * `pltd.md` §2), exposing the setter for the prompt. */
function usePrclEntry(
  zpcr: Zpcr,
  name: string,
): { prcl: Prcl; setPassword: (v: string) => void } {
  const [password, setPassword] = usePltdPassword();
  const prcl = useMemo(
    () => parsePrcl(zpcr.archive.bytes(name), password ? { password } : undefined),
    [zpcr, name, password],
  );
  return { prcl, setPassword };
}

/** The ZIP container facts — shown alongside the password prompt when the payload is locked.
 * The plaintext variant (`prcl.md` §1.1) has no container to show. */
function UndecodedNote({ prcl }: { prcl: Prcl }) {
  const c = prcl.container;
  if (c.format !== "zip") return null;
  return (
    <section className="decoded__block">
      <h3 className="decoded__h">Container</h3>
      <dl className="decoded__dl mono">
        <Pair k="Inner name" v={c.innerName ?? "—"} />
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

/** `.prcl` archive entry → decoded protocol, handling the password prompt. */
export function DecodedProtocol({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const { prcl, setPassword } = usePrclEntry(zpcr, name);

  if (prcl.needsPassword || prcl.error) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!prcl.error} onSubmit={setPassword} />
        <UndecodedNote prcl={prcl} />
      </div>
    );
  }
  if (!prcl.protocol) return <div className="decoded__na mono">No protocol for {name}.</div>;
  const sourceHint =
    prcl.container.format === "zip"
      ? `${prcl.container.innerName} · ${prcl.container.compressionMethod === 9 ? "DEFLATE64" : "DEFLATE"} · decrypted`
      : "plaintext .prcl (no ZIP container — see prcl.md §1.1)";
  return <ProtocolDetail protocol={prcl.protocol} sourceHint={sourceHint} />;
}

/**
 * The decoded protocol for a {@link ProtocolDocument}: root settings (lid, volume, real-time)
 * plus the ordered step table when one was parsed from the XML `protocol2` payload, or the
 * flat `;`-separated `runDefinition` text (via the shared {@link ProtocolDecoded}) for the
 * plaintext variant (`prcl.md` §1.1), which carries no XML step list. Exported so
 * `PcrdRawView.tsx` can render a `.pcrd`'s embedded `protocol2` the same way.
 */
export function ProtocolDetail({
  protocol,
  sourceHint,
}: {
  protocol: ProtocolDocument;
  sourceHint?: string;
}) {
  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">{protocol.name || "Protocol"}</h3>
        <dl className="decoded__dl mono">
          <Pair
            k="Lid"
            v={
              Number.isFinite(protocol.lidTemperatureC)
                ? `${protocol.lidTemperatureC}°C${protocol.useDefaultLidTemperature ? " (default)" : ""}`
                : "—"
            }
          />
          <Pair
            k="Shutoff"
            v={
              protocol.shutoffLidEnabled && Number.isFinite(protocol.shutoffTemperatureC)
                ? `below ${protocol.shutoffTemperatureC}°C`
                : "disabled"
            }
          />
          <Pair k="Volume" v={Number.isFinite(protocol.volumeUl) ? `${protocol.volumeUl} µL` : "—"} />
          <Pair k="Real-time" v={protocol.isRealTime ? "yes" : "no"} />
        </dl>
        {sourceHint && <span className="decoded__hint mono">{sourceHint}</span>}
      </section>

      {protocol.steps ? (
        <section className="decoded__block">
          <h3 className="decoded__h">Steps</h3>
          <ProtocolStepsTable steps={protocol.steps} />
        </section>
      ) : (
        <section className="decoded__block">
          <h3 className="decoded__h">Run definition</h3>
          <span className="decoded__hint mono">
            No structured step list (plaintext protocol, prcl.md §1.1) — parsed from the text
            grammar below.
          </span>
          <ProtocolDecoded text={protocol.runDefinition} />
        </section>
      )}
    </div>
  );
}

/**
 * `.prcl` "Text" mode: the decrypted `<protocol2>` XML for the ZIP variant, or the raw
 * `runDefinition` line for the plaintext variant (`prcl.md` §1.1), which has no XML.
 */
export function ProtocolXml({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const { prcl, setPassword } = usePrclEntry(zpcr, name);
  const xml = prcl.xml ?? "";
  if (prcl.needsPassword || prcl.error) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!prcl.error} onSubmit={setPassword} />
        <UndecodedNote prcl={prcl} />
      </div>
    );
  }
  if (prcl.container.format === "text") {
    return (
      <div className="decoded">
        <ProtocolDecoded text={prcl.protocol?.runDefinition ?? ""} />
      </div>
    );
  }
  if (!xml) return <div className="decoded__na mono">No XML for {name}.</div>;
  return <XmlTreeFromString xml={xml} />;
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <div className="decoded__pair">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
