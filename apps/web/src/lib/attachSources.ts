import {
  formatRunDefinitionText,
  isPltdName,
  plateToCsv,
  type PlateDefinition,
  type Zpcr,
} from "@zpcrweb/core";
import { plateCsvFileName, plateDisplayName } from "./plateNames";
import { protocolFileBase } from "./protocolFileBase";
import { fileBytes, type LoadedFile, type RunResult } from "../state/useZpcrStore";

/**
 * What the attach/replace menus offer: **every plate (or protocol) this browser is holding, not
 * every plate *file***.
 *
 * The distinction is the whole point of this module. A plate is a plate whether it arrived as a
 * standalone `.pltd` or is sitting inside a run someone already loaded, and the menus used to see
 * only the first kind — so re-using last week's layout meant opening that run, cloning its plate
 * out to a top-level file, and only then coming back to attach it. The clone step was pure
 * ceremony: the bytes were already in the browser. Same for a protocol inside a run.
 *
 * A source is therefore *addressed* by where it lives but *identified* by what it is, and building
 * the `File` is deferred to {@link AttachSource.file}: a menu of a dozen plates renders as a dozen
 * labels, and only the one that gets picked is ever serialized.
 *
 * The run being attached *to* is excluded (`excludeId`), since offering a file its own plate back
 * is an operation with no effect and a confirmation prompt in front of it.
 */
export interface AttachSource {
  /** React key, unique across the list. */
  key: string;
  /** The item's own name — a plate's identity, a protocol's name, or a standalone file's name. */
  label: string;
  /** The loaded file it came out of, when that isn't the item itself. Absent for a standalone
   * `.pltd`/`.plt.csv`/`.prcl.txt`, where {@link label} is already the file. */
  from?: string;
  /**
   * The bytes to attach, built on demand. Lazy because serializing a plate to CSV to render a menu
   * row would be work for every item to answer a question about one of them.
   */
  file: () => File;
}

const encode = (text: string) => new TextEncoder().encode(text);

/** A plate held inside a run: its original `.pltd` bytes when the archive has them, else a
 * `.plt.csv` written from the decoded plate — the same two forms `PlateDownloadButton` offers,
 * and the same two `attachPlate` accepts. */
function plateFromRun(zpcr: Zpcr, entryName: string, plate: PlateDefinition | undefined) {
  // A real `.pltd` entry is handed over verbatim, encrypted or not: re-encoding it through
  // `plateToCsv` would drop everything the CSV form doesn't carry, and an entry that needs a
  // password we don't have has no decoded plate to re-encode anyway.
  if (isPltdName(entryName) && zpcr.archive.entries.length > 0) {
    return {
      label: entryName,
      file: () => new File([zpcr.archive.bytes(entryName).slice()], entryName),
    };
  }
  if (!plate) return null;
  return {
    label: plateDisplayName(plate),
    file: () => new File([encode(plateToCsv(plate))], plateCsvFileName(plate)),
  };
}

/**
 * Every plate that can be attached to `excludeId`'s run: the standalone `.pltd`/`.plt.csv` files,
 * plus each plate embedded in any *other* loaded run.
 *
 * `password` is the shared `.pltd` decryption password, needed to decode an encrypted plate well
 * enough to name it. Without one, an encrypted entry still appears — it is a real `.pltd` and gets
 * offered by its archive entry name, which is what would be attached anyway.
 */
export function plateSources(
  files: LoadedFile[],
  runs: Map<string, RunResult>,
  excludeId: string | null,
  password?: string,
): AttachSource[] {
  const sources: AttachSource[] = [];
  for (const f of files) {
    if (f.name === excludeId) continue;
    if (f.kind === "pltd" || f.kind === "csv") {
      sources.push({
        key: f.name,
        label: f.name,
        file: () => new File([fileBytes(f).slice()], f.name),
      });
      continue;
    }
    const zpcr = runs.get(f.name)?.zpcr;
    if (!zpcr) continue;
    for (const entry of zpcr.plates(password)) {
      const source = plateFromRun(zpcr, entry.name, entry.pltd.plate);
      if (source) sources.push({ key: `${f.name}:${entry.name}`, from: f.name, ...source });
    }
  }
  return sources;
}

/**
 * Every protocol that can be attached: the standalone `.prcl.txt` files, plus the protocol inside
 * any *other* loaded run — including a run that has already happened, which is the common case
 * worth having (running the same protocol again is what a past run's protocol is *for*).
 *
 * The `File` is named after the protocol rather than after the file it came out of, because that
 * name is what `attachProtocol` stores as the archive's `ProtocolName.txt`.
 */
export function protocolSources(
  files: LoadedFile[],
  runs: Map<string, RunResult>,
  excludeId: string | null,
): AttachSource[] {
  const sources: AttachSource[] = [];
  for (const f of files) {
    if (f.name === excludeId) continue;
    if (f.kind === "prcl") {
      sources.push({
        key: f.name,
        label: f.name,
        file: () => new File([fileBytes(f).slice()], f.name),
      });
      continue;
    }
    const zpcr = runs.get(f.name)?.zpcr;
    const text = zpcr?.protocolText;
    if (!zpcr || !text) continue;
    const name = zpcr.protocol()?.name?.trim() || "";
    sources.push({
      key: `${f.name}:protocol`,
      label: name || "Thermal protocol",
      from: f.name,
      file: () =>
        new File([encode(formatRunDefinitionText(text))], `${protocolFileBase(name, f.name)}.prcl.txt`),
    });
  }
  return sources;
}
