/**
 * `.prcl` thermal-cycling protocol files — the lid/volume settings plus the ordered step list
 * (hold, gradient, melt, goto, plate read). See `prcl.md` for the full reverse-engineered
 * format.
 *
 * Container: the same single-entry ZipCrypto-encrypted ZIP as `.pltd` (see `pltd.ts`),
 * compressed with DEFLATE (method 8) or DEFLATE64 (method 9), sharing the fixed standard-mode
 * password. At least one shipped protocol (`BurnIn.prcl`) is instead a bare, unencrypted
 * `[ProtocolRunDefinition version …]` text file with no ZIP wrapper and no XML step list — see
 * `prcl.md` §1.1. {@link parsePrcl} sniffs the leading bytes to pick a path.
 *
 * The payload's `<protocol2>` XML is also what `.pcrd` embeds for the protocol it ran (see
 * `pcrd.md` §2.4) — {@link parseProtocol2} is exported so `pcrd.ts` can reuse it.
 */

import { zipCryptoDecrypt } from "./zipcrypto.js";
import { inflateRaw } from "./inflate.js";
import { parseSingleEntryZip } from "./zipsingle.js";
import { findElement, firstTagAttrs, splitElements, stripBomBytes } from "./xmlLite.js";

/** A `TemperatureStep`: hold one temperature. */
export interface TemperatureStep {
  kind: "temperature";
  /** 0-based position in `protocol2BaseList` (`temperatureStepNumber`). */
  stepNumber: number;
  tempC: number;
  holdSeconds: number;
  /** True when this step carries a nested `<PlateReadOption>` — the instrument reads the
   * plate at the end of this hold. */
  plateRead: boolean;
}

/** A `GradientStep`: hold a temperature gradient across the block's rows. */
export interface GradientStep {
  kind: "gradient";
  stepNumber: number;
  lowTempC: number;
  highTempC: number;
  holdSeconds: number;
  plateRead: boolean;
}

/** A `MeltCurveStep`: ramp from a start temperature in increments, reading at each step. */
export interface MeltCurveStep {
  kind: "melt";
  stepNumber: number;
  startTempC: number;
  /**
   * The `meltCurveEndTemp` XML attribute — present directly in the XML, unlike the text
   * `runDefinition` form, which omits it entirely (see `prcl.md` §2.3). Falls back to
   * `startTempC + gotoRepeats * incrementC`, derived from the `GotoStep` that closes this
   * melt's loop, on the rare file that omits the attribute; undefined only if neither source
   * is available (a malformed or truncated step list).
   */
  endTempC?: number;
  incrementC: number;
  holdSeconds: number;
  plateRead: boolean;
}

/** A `GotoStep`: loop back to an earlier step and repeat it. */
export interface GotoStep {
  kind: "goto";
  stepNumber: number;
  /** 0-based target step index (`optionGotoStep`) — 0-based in the XML, unlike the 1-based
   * `GOTO` verb in the `runDefinition` text form (`prcl.md` §3). */
  targetStep: number;
  /** Additional repeats (`optionGotoCycle`) — the loop body executes `repeats + 1` times total. */
  repeats: number;
}

/** One step of the ordered `protocol2BaseList`, discriminated by `kind`. */
export type ProtocolStep = TemperatureStep | GradientStep | MeltCurveStep | GotoStep;

/** A fully decoded thermal-cycling protocol. */
export interface ProtocolDocument {
  /** File name (`identifier`'s `identityKey`), e.g. `Unknown.prcl`. */
  name: string;
  /** Heated-lid setpoint, °C. */
  lidTemperatureC: number;
  /** Whether the lid setpoint is the app default rather than user-set. */
  useDefaultLidTemperature: boolean;
  /** Whether the lid heater turns off below `shutoffTemperatureC`. */
  shutoffLidEnabled: boolean;
  shutoffTemperatureC: number;
  /** Sample volume, µL — drives the instrument's thermal model. */
  volumeUl: number;
  /** Real-time (plate-reading) protocol vs. a conventional thermal-cycler run. */
  isRealTime: boolean;
  isEmailWhenComplete: boolean;
  /**
   * The whole protocol as one `;`-delimited text line (`prcl.md` §3). Not byte-identical to
   * the archive's `ProtocolRunDefinition.txt` for the same run — see `prcl.md` §3 for the two
   * known differences (the `PLATEREAD` operand, the `END` terminator).
   */
  runDefinition: string;
  /**
   * Header metadata (created/modified dates, app versions, guid, …) as raw strings. May carry
   * the authoring machine's real absolute path / computer name / user — treat as incidental
   * personal/environmental data, not surfaced by default (`prcl.md` §2.2).
   */
  meta: Record<string, string>;
  /**
   * Ordered step list, present when parsed from the XML `protocol2` payload. Undefined for the
   * plaintext-only variant (`BurnIn.prcl`, `prcl.md` §1.1), which carries no XML — only
   * `runDefinition`.
   */
  steps?: ProtocolStep[];
}

/**
 * Parse a `<protocol2>` XML fragment into a typed {@link ProtocolDocument}. Exported so
 * `pcrd.ts` can reuse it for the `protocol2` subtree embedded in a `.pcrd` document (`pcrd.md`
 * §2.4) — same schema, same root tag.
 */
export function parseProtocol2(xml: string): ProtocolDocument {
  const root = firstTagAttrs(xml, "protocol2");
  const identifier = firstTagAttrs(xml, "identifier");
  const meta = firstTagAttrs(xml, "header");
  // `protocol2BaseList` is a child of `<protocol2>`, not a depth-0 element of `xml` itself
  // (which may carry an XML declaration and be `<protocol2>` at depth 0) — descend into the
  // root element's own children before searching.
  const rootEl = findElement(xml, "protocol2") ?? { inner: xml };
  const listEl = findElement(rootEl.inner, "protocol2BaseList");

  return {
    name: identifier.identityKey ?? meta.name ?? "",
    lidTemperatureC: Number(root.lidTemperature ?? 0) || 0,
    useDefaultLidTemperature: root.useDefaultLidTemperature === "True",
    shutoffLidEnabled: root.shutoffLidEnabled === "True",
    shutoffTemperatureC: Number(root.shutoffTemperature ?? 0) || 0,
    volumeUl: Number(root.volume ?? 0) || 0,
    isRealTime: root.isRealTime === "True",
    isEmailWhenComplete: root.isEmailWhenComplete === "True",
    runDefinition: root.runDefinition ?? "",
    meta,
    steps: listEl ? parseSteps(listEl.inner) : undefined,
  };
}

function parseSteps(listXml: string): ProtocolStep[] {
  const steps: ProtocolStep[] = [];
  for (const el of splitElements(listXml)) {
    const hasPlateRead = () => !!findElement(el.inner, "PlateReadOption");
    switch (el.name.toLowerCase()) {
      case "temperaturestep":
        steps.push({
          kind: "temperature",
          stepNumber: Number(el.attrs.temperatureStepNumber ?? 0) || 0,
          tempC: Number(el.attrs.temperatureStepTemp ?? 0) || 0,
          holdSeconds: Number(el.attrs.temperatureStepHoldTime ?? 0) || 0,
          plateRead: hasPlateRead(),
        });
        break;
      case "gradientstep":
        steps.push({
          kind: "gradient",
          stepNumber: Number(el.attrs.gradientStepNumber ?? 0) || 0,
          lowTempC: Number(el.attrs.gradientStepLowTemp ?? 0) || 0,
          highTempC: Number(el.attrs.gradientStepHighTemp ?? 0) || 0,
          holdSeconds: Number(el.attrs.gradientStepHoldTime ?? 0) || 0,
          plateRead: hasPlateRead(),
        });
        break;
      case "meltcurvestep": {
        // `meltCurveEndTemp` is a real XML attribute (unlike the text form, which omits it —
        // prcl.md §2.3) — read it directly; only derive it below if it's ever missing.
        const endAttr = Number(el.attrs.meltCurveEndTemp);
        steps.push({
          kind: "melt",
          stepNumber: Number(el.attrs.meltCurveStepNumber ?? 0) || 0,
          startTempC: Number(el.attrs.meltCurveStartTemp ?? 0) || 0,
          endTempC: Number.isFinite(endAttr) ? endAttr : undefined,
          incrementC: Number(el.attrs.meltCurveTemperatureIncrement ?? 0) || 0,
          holdSeconds: Number(el.attrs.meltCurveHoldTime ?? 0) || 0,
          plateRead: hasPlateRead(),
        });
        break;
      }
      case "gotostep":
        steps.push({
          kind: "goto",
          stepNumber: Number(el.attrs.optionGotoStepNumber ?? 0) || 0,
          targetStep: Number(el.attrs.optionGotoStep ?? 0) || 0,
          repeats: Number(el.attrs.optionGotoCycle ?? 0) || 0,
        });
        break;
      default:
        break;
    }
  }

  // Fall back to deriving a missing MeltCurveStep.endTempC from the GotoStep that closes its
  // loop (prcl.md §2.3) — the attribute above should always be present, but this keeps the
  // field populated even if a file ever omits it.
  for (const step of steps) {
    if (step.kind !== "melt" || step.endTempC !== undefined) continue;
    const closingGoto = steps.find(
      (s): s is GotoStep => s.kind === "goto" && s.targetStep === step.stepNumber,
    );
    if (closingGoto) step.endTempC = step.startTempC + closingGoto.repeats * step.incrementC;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Plaintext variant (prcl.md §1.1)
// ---------------------------------------------------------------------------

const PLAINTEXT_HEADER = /^\[ProtocolRunDefinition[^\]]*\]/;
const PLAINTEXT_PREFIX = new TextEncoder().encode("[ProtocolRunDefinition");

function isPlaintextPrcl(bytes: Uint8Array): boolean {
  // The plaintext variant (prcl.md §1.1) starts with the literal `[ProtocolRunDefinition`
  // header. Everything else is the ZIP variant — checked by absence, not by the `PK\x03\x04`
  // local-file-header magic, because some real `.prcl` ZIPs carry a 4-byte spanning marker
  // (`PK\x07\x08`) before the actual local header (see `zipsingle.ts`'s central-directory
  // based parsing, which is robust to it).
  return PLAINTEXT_PREFIX.every((b, i) => bytes[i] === b);
}

function parsePlaintextPrcl(bytes: Uint8Array): Prcl {
  const raw = textDecoder.decode(stripBomBytes(bytes)).replace(/\r\n/g, "\n").trim();
  const runDefinition = raw.replace(PLAINTEXT_HEADER, "").trim();
  const hotlid = /HOTLID\s+([\d.]+)\s*,\s*([\d.]+)/i.exec(runDefinition);
  const volume = /VOLUME\s+([\d.]+)/i.exec(runDefinition);

  return {
    container: { format: "text" },
    protocol: {
      name: "",
      lidTemperatureC: hotlid ? Number(hotlid[1]) : NaN,
      useDefaultLidTemperature: false,
      shutoffLidEnabled: false,
      shutoffTemperatureC: hotlid ? Number(hotlid[2]) : NaN,
      volumeUl: volume ? Number(volume[1]) : NaN,
      isRealTime: false,
      isEmailWhenComplete: false,
      runDefinition,
      meta: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Metadata about the `.prcl` ZIP container. Absent (`format: "text"`) for the plaintext
 * variant (`prcl.md` §1.1), which has no ZIP wrapper at all. */
export interface PrclContainer {
  format: "zip" | "text";
  /** Inner entry file name inside the `.prcl` ZIP. Only set for `format: "zip"`. */
  innerName?: string;
  /** ZIP compression method: 8 = DEFLATE, 9 = DEFLATE64. */
  compressionMethod?: number;
  /** Whether the entry is ZipCrypto-encrypted (always true for CFX files). */
  encrypted?: boolean;
  /** CRC-32 of the decompressed entry (from the central directory). */
  crc32?: number;
  /** Compressed (and encrypted) size in bytes. */
  compressedSize?: number;
  /** Decompressed size in bytes. */
  uncompressedSize?: number;
}

/** The result of {@link parsePrcl}: always the container, plus the protocol when decoded. */
export interface Prcl {
  container: PrclContainer;
  /** The decoded protocol, when decryption + parse succeeded (or always, for the plaintext
   * variant, which needs no decryption). */
  protocol?: ProtocolDocument;
  /** The raw decoded XML, when decryption + inflate succeeded (before parsing). Absent for the
   * plaintext variant, which has no XML. */
  xml?: string;
  /**
   * True when the entry is encrypted but no password was supplied — nothing was attempted.
   * (Distinct from {@link error}, which means a password was tried and failed.)
   */
  needsPassword?: boolean;
  /** Set when decoding failed (e.g. wrong password); `protocol`/`xml` are then undefined. */
  error?: string;
}

/** Options for {@link parsePrcl}. */
export interface PrclOptions {
  /** The decryption password. Required for the encrypted ZIP variant (not the plaintext one). */
  password?: string;
}

const textDecoder = new TextDecoder("utf-8");

/**
 * Parse a `.prcl` file: sniff the container (encrypted ZIP vs. bare plaintext, `prcl.md`
 * §1.1), decrypt + inflate the ZIP variant, and parse the `<protocol2>` XML into a typed
 * {@link ProtocolDocument}.
 *
 * The container metadata is always returned. When the entry is encrypted and no password is
 * supplied, `needsPassword` is set (nothing is attempted). If decryption/inflate fails (e.g. a
 * wrong password), {@link Prcl.error} is set instead. In both cases `protocol`/`xml` are
 * omitted rather than throwing, so callers can still show the container and a raw hex view.
 *
 * @param bytes raw `.prcl` file bytes.
 * @param options must include `password` for the encrypted ZIP variant; this library does not
 *   embed one. See `pltd.md` for how a licensed CFX Manager user can obtain it.
 */
export function parsePrcl(bytes: Uint8Array, options: PrclOptions = {}): Prcl {
  if (isPlaintextPrcl(bytes)) return parsePlaintextPrcl(bytes);

  const entry = parseSingleEntryZip(bytes);
  const container: PrclContainer = {
    format: "zip",
    innerName: entry.name,
    compressionMethod: entry.method,
    encrypted: entry.encrypted,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
  };

  if (entry.encrypted && !options.password) {
    return { container, needsPassword: true };
  }

  try {
    const compressed = entry.encrypted
      ? zipCryptoDecrypt(entry.data, options.password as string)
      : entry.data;

    let inflated: Uint8Array;
    if (entry.method === 8 || entry.method === 9) {
      inflated = inflateRaw(compressed, entry.uncompressedSize, entry.method === 9);
    } else if (entry.method === 0) {
      inflated = compressed;
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.method}`);
    }

    const xml = textDecoder.decode(stripBomBytes(inflated));
    const protocol = /<protocol2\b/.test(xml) ? parseProtocol2(xml) : undefined;
    return { container, xml, protocol };
  } catch (e) {
    return { container, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True for archive entry names this module can parse (`.prcl` protocol files). */
export function isPrclName(name: string): boolean {
  return /\.prcl$/i.test(name);
}
