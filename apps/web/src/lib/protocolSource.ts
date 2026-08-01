/**
 * Where a thermal protocol can come from, for the Device view's "stage a protocol" panel.
 *
 * The instrument has no protocol library of its own to pick from — `usb.md` §5's live probe found
 * `\Storage Card` holds nothing but `CurrentRun` and `PCRunReport` — so a run's protocol is
 * whatever the host sends it. That makes "choose a protocol" a question about files *this app*
 * has, which is what this module answers: every loaded run that carries an ASCII run definition
 * is a candidate, and a `.prcl.txt` from disk is the escape hatch for one that isn't loaded.
 *
 * **The ASCII text form is the only representation offered, deliberately.** A `.prcl`/`.pltd` is
 * an encrypted container (`zipcrypto.md`), and the evidence is that the instrument never decrypts
 * one: of the five committed samples — all written by the instrument itself — every one carries
 * `ProtocolRunDefinition.txt` and only one carries a `.prcl` at all, none a `.pltd` from the
 * device. Encryption arrived in CFX Manager, and the firmware looks to have been left alone; the
 * encrypted pair reads as the PC software round-tripping its own config through a run's results.
 * So the plaintext directive list is both the portable form and, most likely, the only one that
 * matters to the instrument.
 */
import { protocolDocumentFromRunDefinition, type ProtocolDocument } from "@zpcrweb/core";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";

/** One loaded file, as offered in the Device view's protocol picker. */
export interface ProtocolCandidate {
  /** The {@link LoadedFile} id, and the selection key. */
  id: string;
  fileName: string;
  /** Display name of the protocol, when the run names one. */
  protocolName: string | null;
  /** The ASCII run definition, or `null` when this file has none to offer. */
  runDefinition: string | null;
  /** Why it can't be picked — shown as the row's tooltip. `null` when it can. */
  unavailable: string | null;
}

/** A protocol staged for a run: from a loaded file, or from a `.prcl.txt` off disk. */
export interface ProtocolSelection {
  origin: "file" | "upload";
  /** What to call it in the panel heading — a protocol name, or the file it came from. */
  label: string;
  /** The `.prcl.txt` base name a download would use. */
  fileBase: string;
  /** Canonical one-line run definition (`prcl.md` §3). */
  runDefinition: string;
  /** Best-effort decode of the above, for the step table. */
  document: ProtocolDocument;
}

/**
 * A filename base for a protocol download: the protocol's own name when it has one, else the
 * source file's name without its extension. Punctuation a filesystem might object to is
 * flattened to `_` — shipped protocol names are free-form strings and some carry slashes.
 */
export function protocolFileBase(protocolName: string | null | undefined, fileName: string): string {
  const base = protocolName?.trim() || fileName.replace(/\.[^.]+$/, "");
  return base.replace(/[\\/:*?"<>|]+/g, "_") || "protocol";
}

/** Build the {@link ProtocolSelection} for a candidate the caller has checked is available. */
export function selectionFromCandidate(c: ProtocolCandidate): ProtocolSelection | null {
  if (!c.runDefinition) return null;
  return {
    origin: "file",
    label: c.protocolName || c.fileName,
    fileBase: protocolFileBase(c.protocolName, c.fileName),
    runDefinition: c.runDefinition,
    document: protocolDocumentFromRunDefinition(c.protocolName || "", c.runDefinition),
  };
}

/** Build a {@link ProtocolSelection} from a `.prcl.txt` the user picked off disk. */
export function selectionFromText(fileName: string, runDefinition: string): ProtocolSelection {
  const base = protocolFileBase(null, fileName.replace(/\.prcl\.txt$/i, ""));
  return {
    origin: "upload",
    label: fileName,
    fileBase: base,
    runDefinition,
    document: protocolDocumentFromRunDefinition(base, runDefinition),
  };
}

/**
 * Every loaded file as a pick-or-not row, in the order the file bar shows them.
 *
 * A file that can't offer a protocol is listed rather than hidden, with the reason: "this run
 * has no protocol in it" and "this run hasn't been decrypted yet" are different problems, and
 * only one of them is fixed by typing a password.
 */
export function protocolCandidates(
  files: LoadedFile[],
  runs: Map<string, RunResult>,
  plateFiles: Map<string, PlateFileResult>,
): ProtocolCandidate[] {
  return files.map((f) => {
    const base = { id: f.id, fileName: f.name, protocolName: null, runDefinition: null };
    // A standalone plate file is the other half of a run — wells, not thermal steps.
    if (plateFiles.has(f.id)) {
      return { ...base, unavailable: "A plate file carries no thermal protocol." };
    }
    const run = runs.get(f.id);
    if (!run?.zpcr) {
      return {
        ...base,
        unavailable: run?.needsPassword
          ? "Encrypted — open it with the password first."
          : (run?.error ?? "This file hasn't finished loading."),
      };
    }
    const runDefinition = run.zpcr.protocolText || null;
    const protocolName = run.zpcr.protocol()?.name || null;
    return {
      ...base,
      protocolName,
      runDefinition,
      unavailable: runDefinition
        ? null
        : "No embedded ASCII protocol — this run carries no run-definition text.",
    };
  });
}
