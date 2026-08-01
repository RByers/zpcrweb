/**
 * Resolve a {@link RunStagingSelection} into the two halves of a run: a thermal protocol and a
 * plate map, each with the file it came from.
 *
 * The instrument has no protocol library of its own to pick from — `usb.md` §5.1's live probe
 * found `\Storage Card` holds nothing but `CurrentRun` and `PCRunReport` — so what a run executes
 * is whatever the host sends it, and "choose a protocol" is a question about the app's own files.
 *
 * **The ASCII text form is the only protocol representation offered, deliberately.** A
 * `.prcl`/`.pltd` is an encrypted container (`zipcrypto.md`), and the evidence is that the
 * instrument never decrypts one: of the five committed samples — all written by the instrument
 * itself — every one carries `ProtocolRunDefinition.txt`, only one carries a `.prcl` at all, and
 * none a `.pltd` from the instrument. Encryption arrived in CFX Manager and the firmware looks
 * to have been left alone; the encrypted pair reads as the PC software round-tripping its own config
 * through a run's results. So the plaintext directive list is both the portable form and, most
 * likely, the only one that matters to the instrument. See `usb.md` §5.1.
 */
import {
  parsePlateCsv,
  protocolDocumentFromRunDefinition,
  type PlateDefinition,
  type ProtocolDocument,
  type Zpcr,
} from "@zpcrweb/core";
import type { RunStagingSelection } from "../state/useRunStaging";
import type { LoadedFile, PlateFileResult, RunResult } from "../state/useZpcrStore";
import type { ExperimentIdentity } from "./experiment";

/**
 * Re-read a staged `.plt.csv` against the selected run's own dye → channel mapping.
 *
 * A plate CSV labels its fluor columns with the dye name alone — the channel is a fact about the
 * optics, not about the plate, so the format doesn't record it (`plateCsv.ts`). Parsed on its own
 * (which is what the store does, having no run to consult) every fluor's channel is therefore
 * unknown, and the preview shows dyes with no channel and no colour.
 *
 * Pairing it with a run here is not the guess the store declines to make. The store sees a
 * `.plt.csv` sitting in a list beside unrelated files and cannot know which instrument it belongs
 * to; here the user has explicitly staged this plate *with this run*, as the two halves of one
 * experiment on one instrument — which is exactly the statement the mapping needs, and the same
 * one `zpcr.plates()` acts on for a `.plt.csv` stored inside an archive.
 *
 * Returns `null` when there is nothing to add (no run, or the CSV no longer parses), leaving the
 * caller with the store's channel-less parse rather than no plate at all.
 */
function plateWithRunChannels(
  bytes: Uint8Array,
  sourceName: string,
  zpcr: Zpcr | null,
): PlateDefinition | null {
  if (!zpcr) return null;
  try {
    return parsePlateCsv(new TextDecoder().decode(bytes), {
      sourceName,
      channelForFluor: (fluor) => zpcr.channelForDye(fluor),
    });
  } catch {
    return null;
  }
}

/** One half of a staged run, and where it came from. */
export interface StagedPart<T> {
  value: T | null;
  /** The file supplying it — a `.prcl.txt`/plate file when overridden, else the run. */
  sourceName: string | null;
  /** True when an override supplies it rather than the selected run. */
  overridden: boolean;
  /** Why there is nothing, when `value` is null and something was selected. */
  reason: string | null;
}

/** The protocol half: the directives that would be sent, plus a decode of them. */
export interface StagedProtocol {
  runDefinition: string;
  document: ProtocolDocument;
}

export interface StagedRun {
  protocol: StagedPart<StagedProtocol>;
  plate: StagedPart<PlateDefinition>;
  /** The run supplying whatever isn't overridden, when one is selected. */
  runName: string | null;
  /**
   * The run whose calibration set gave the staged plate its channels, when that happened. A
   * `.plt.csv` records dye names only, so this is the one thing a run still contributes when both
   * halves are overridden — and naming it is what keeps a run chip from being lit for no reason a
   * reader can see.
   */
  channelsFrom: string | null;
}

/** Nothing staged — what every view other than Instrument gets, since none of them read it. */
export const EMPTY_STAGED_RUN: StagedRun = {
  protocol: { value: null, sourceName: null, overridden: false, reason: null },
  plate: { value: null, sourceName: null, overridden: false, reason: null },
  runName: null,
  channelsFrom: null,
};

/**
 * A filename base for a protocol download: the protocol's own name when it has one, else the
 * source file's name without its extension. Punctuation a filesystem might object to is
 * flattened to `_` — shipped protocol names are free-form strings and some carry slashes.
 */
export function protocolFileBase(protocolName: string | null | undefined, fileName: string): string {
  const base = protocolName?.trim() || fileName.replace(/\.[^.]+$/, "");
  return base.replace(/[\\/:*?"<>|]+/g, "_") || "protocol";
}

/** Why a selected run can't supply anything yet — the same answer for either half. */
function runProblem(run: RunResult | undefined): string | null {
  if (!run) return "This file hasn't finished loading.";
  if (run.zpcr) return null;
  if (run.needsPassword) return "Encrypted — open it with the password first.";
  return run.error ?? "This file hasn't finished loading.";
}

export function resolveStagedRun(
  selection: RunStagingSelection,
  files: LoadedFile[],
  runs: Map<string, RunResult>,
  plateFiles: Map<string, PlateFileResult>,
  protocolFiles: Map<string, string>,
  password: string,
  experiments?: Map<string, ExperimentIdentity>,
): StagedRun {
  const byId = new Map(files.map((f) => [f.id, f]));
  const runFile = selection.runId ? (byId.get(selection.runId) ?? null) : null;
  // A run is shown by its experiment name, as everywhere else in the app (`lib/experiment.ts`).
  // The override files keep their file names: a `.prcl.txt`/`.plt.csv` is not an experiment and
  // has no name but the one on disk.
  const runLabel = runFile
    ? ((experiments?.get(runFile.id)?.name || "").trim() || runFile.name)
    : null;
  const run = selection.runId ? runs.get(selection.runId) : undefined;
  const zpcr = run?.zpcr ?? null;
  const problem = selection.runId ? runProblem(run) : null;

  // --- protocol ---------------------------------------------------------------------------
  let protocol: StagedPart<StagedProtocol>;
  const overrideText = selection.protocolId ? protocolFiles.get(selection.protocolId) : undefined;
  if (selection.protocolId && overrideText) {
    const name = byId.get(selection.protocolId)?.name ?? "";
    protocol = {
      value: {
        runDefinition: overrideText,
        document: protocolDocumentFromRunDefinition(
          protocolFileBase(null, name.replace(/\.prcl\.txt$/i, "")),
          overrideText,
        ),
      },
      sourceName: name,
      overridden: true,
      reason: null,
    };
  } else {
    const text = zpcr?.protocolText || null;
    protocol = {
      value: text
        ? {
            runDefinition: text,
            document: protocolDocumentFromRunDefinition(zpcr?.protocol()?.name || "", text),
          }
        : null,
      sourceName: text ? runLabel : null,
      overridden: false,
      reason: text
        ? null
        : !selection.runId
          ? null
          : (problem ?? "This run carries no run-definition text."),
    };
  }

  // --- plate ------------------------------------------------------------------------------
  let plate: StagedPart<PlateDefinition>;
  let channelsFrom: string | null = null;
  if (selection.plateId) {
    const result = plateFiles.get(selection.plateId);
    const file = byId.get(selection.plateId);
    // A `.plt.csv` records no channels; borrow the selected run's. Only for a CSV — a `.pltd`
    // carries `channelPosition` itself, so re-reading one would gain nothing.
    const mapped =
      result?.plate && file?.kind === "csv"
        ? plateWithRunChannels(file.bytes, file.name, zpcr)
        : null;
    // Only claimed when it actually resolved something: a run that calibrates none of the CSV's
    // dyes has contributed nothing, and saying otherwise would be worse than saying nothing.
    if (mapped?.fluors.some((f) => f.channel !== undefined)) {
      channelsFrom = runLabel;
    }
    plate = {
      value: mapped ?? result?.plate ?? null,
      sourceName: file?.name ?? null,
      overridden: true,
      reason: result?.plate
        ? null
        : result?.needsPassword
          ? "Encrypted — open it with the password first."
          : (result?.error ?? "This plate file hasn't finished loading."),
    };
  } else {
    // A run's own embedded plate. An instrument-written `.zpcr` usually has none (see the module
    // comment), so this half often stays empty until a `.pltd`/`.plt.csv` is picked — which is
    // exactly the case the override mechanism exists for.
    const embedded = zpcr?.plates(password || undefined)[0]?.pltd.plate ?? null;
    plate = {
      value: embedded,
      sourceName: embedded ? runLabel : null,
      overridden: false,
      reason: embedded
        ? null
        : !selection.runId
          ? null
          : (problem ?? "This run carries no plate map — pick a .pltd or .plt.csv file."),
    };
  }

  return {
    protocol,
    plate,
    runName: runLabel,
    channelsFrom: channelsFrom ?? null,
  };
}
