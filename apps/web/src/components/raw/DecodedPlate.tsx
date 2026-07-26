import { useMemo } from "react";
import { isPlateCsvName, parsePlateCsv, parsePltd, type Pltd, type Zpcr } from "@zpcrweb/core";
import { PlateTable } from "./PlateTable";
import { XmlTreeFromString } from "../../lib/xmlTree";
import { usePltdPassword } from "../../state/pltdPassword";
import { PasswordPrompt } from "../PasswordPrompt";

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
 * `.pltd` or `.plt.csv` archive entry → decoded plate data, using the same {@link PlateTable}
 * (and so the same `PlateDefinition` object model) either way — for the color-coded visual
 * plate map, see the "Plates" tab. The decrypted `<platesetup2>` XML (`.pltd` only) is
 * available separately via the Raw files "Text"/"XML" mode (see {@link PlateXml}).
 */
export function DecodedPlate({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  if (isPlateCsvName(name)) return <DecodedPlateCsv zpcr={zpcr} name={name} />;

  const { pltd, setPassword } = usePltdEntry(zpcr, name);

  if (pltd.container.encrypted && (pltd.needsPassword || pltd.error)) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
        <UndecodedNote pltd={pltd} />
      </div>
    );
  }
  if (pltd.error) return <div className="decoded__na mono">{pltd.error}</div>;
  if (!pltd.plate) return <div className="decoded__na mono">No plate for {name}.</div>;
  const { container } = pltd;
  return (
    <PlateTable
      plate={pltd.plate}
      sourceHint={`${container.innerName} · ${container.compressionMethod === 9 ? "DEFLATE64" : "DEFLATE"} · decrypted`}
    />
  );
}

/** A `.plt.csv` entry decoded via {@link parsePlateCsv} — plain UTF-8 text, no password/
 * decryption step needed, unlike `.pltd`. */
function DecodedPlateCsv({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const plate = useMemo(() => {
    try {
      return parsePlateCsv(zpcr.archive.text(name));
    } catch {
      return null;
    }
  }, [zpcr, name]);
  if (!plate) return <div className="decoded__na mono">Could not parse {name} as a plate CSV.</div>;
  return <PlateTable plate={plate} sourceHint={`${name} · zpcrweb plate CSV`} />;
}

/** The decrypted `<platesetup2>` XML, pretty-printed (Raw files "Text" mode for `.pltd`). */
export function PlateXml({ zpcr, name }: { zpcr: Zpcr; name: string }) {
  const { pltd, setPassword } = usePltdEntry(zpcr, name);
  const xml = pltd.xml ?? "";
  if (pltd.container.encrypted && (pltd.needsPassword || pltd.error)) {
    return (
      <div className="decoded">
        <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
        <UndecodedNote pltd={pltd} />
      </div>
    );
  }
  if (pltd.error) return <div className="decoded__na mono">{pltd.error}</div>;
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
