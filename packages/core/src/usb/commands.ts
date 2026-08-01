/**
 * Channel 1 — the ASCII command language (`usb.md` §3).
 *
 * A channel-1 payload is a plain command line: ASCII, CR/LF-terminated on the way out, and a
 * response on the way back that ends in a 4-digit result code. The only structural subtlety is
 * that there are **two** response shapes, and which one a command uses is a property of the
 * command, not of the reply:
 *
 * - Commands with something to report separate value from code with a semicolon — `*IDN?` →
 *   `BIO-RAD…,2.0.231.0;0000`, and even an empty value keeps the separator (`ERRORLIST A` → `;0000`).
 * - Pure action commands have no return-value slot at all and answer with the bare code, `0000`.
 *
 * {@link parseResponse} splits at the **last** semicolon rather than the first, because a value
 * may itself be semicolon-delimited — `STATUS?` is twenty such fields — and a leading-split parser
 * would report a block temperature as the whole reply's value.
 */

/** Success. Neither reference capture ever provoked a non-zero code, so what a real failure looks
 * like beyond "not this" is unconfirmed (`usb.md` §3). */
export const OK_CODE = "0000";

export interface CfxResponse {
  /** The response's value, or `null` for a pure action command that has no value slot. */
  value: string | null;
  /** `value` split on `;`. Empty for an action command. `STATUS?`'s twenty fields arrive here. */
  fields: string[];
  /** The trailing 4-digit result code. */
  code: string;
  /** `code === "0000"`. */
  ok: boolean;
  /** The reply exactly as received, minus its trailing newline. */
  raw: string;
}

const DECODER = new TextDecoder("latin1");
const ENCODER = new TextEncoder();

/** Encode a command line as a channel-1 payload. The `\r\n` terminator is added here — every
 * request in both reference captures carries it, so no caller should be passing its own. */
export function encodeCommand(command: string): Uint8Array {
  return ENCODER.encode(`${command}\r\n`);
}

/**
 * Parse a channel-1 response payload.
 *
 * `latin1` rather than UTF-8 on purpose: the payload is ASCII by specification, and a strict
 * UTF-8 decode would turn a byte the firmware never meant as text into U+FFFD. Decoding
 * byte-for-byte keeps a surprising reply diagnosable instead of silently lossy.
 */
export function parseResponse(payload: Uint8Array): CfxResponse {
  const raw = DECODER.decode(payload).replace(/\r?\n$/, "");
  const cut = raw.lastIndexOf(";");
  if (cut < 0) {
    // Action-command shape: the whole reply is the code.
    return { value: null, fields: [], code: raw, ok: raw === OK_CODE, raw };
  }
  const value = raw.slice(0, cut);
  const code = raw.slice(cut + 1);
  return { value, fields: value.split(";"), code, ok: code === OK_CODE, raw };
}

/** Thrown when the instrument answers with a non-success code. */
export class CfxCommandError extends Error {
  constructor(
    readonly command: string,
    readonly response: CfxResponse,
  ) {
    super(`${command} failed with code ${response.code}: ${response.raw}`);
    this.name = "CfxCommandError";
  }
}

/**
 * The directories a run's files live in (`usb.md` §5), as a starting point for a file browser.
 *
 * `\Storage Card` is the volume root and behaves unlike the other two — it lists only the files
 * directly in it (not the directories below), and answers `GETFILESLEN` with a binary payload
 * rather than a length. See {@link CfxDevice.listingLength}.
 */
export const CFX_DIRECTORIES = [
  { path: "\\Storage Card", label: "Storage Card" },
  { path: "\\Storage Card\\CurrentRun", label: "Current run" },
  { path: "\\Storage Card\\PCRunReport", label: "Run reports" },
] as const;

/**
 * How much a command in {@link CFX_COMMANDS} is actually known to do.
 *
 * The distinction is load-bearing rather than decorative. `usb.md` documents only what real
 * traffic demonstrated, so a client wanting a button for something the captures never exercised
 * would be guessing at a command name. Recording that per command lets the UI say so instead of
 * presenting a guess as a feature, and keeps any guesses in one list rather than scattered
 * through call sites.
 *
 * Every entry currently in {@link CFX_COMMANDS} is `observed` — lid close and the indicator were
 * briefly carried here as guesses, until re-reading `usb-basic` found both (`LID CLOSE`, and
 * `BLOCKID` for the indicator). The mechanism stays because the next action command added will
 * need it, and because "how do we know?" is worth being able to answer per command.
 */
export type CommandConfidence =
  /** Observed in a reference capture, or exercised against a live instrument by this library. */
  | "observed"
  /** Plausible by symmetry with an observed command, but never seen. May simply error. */
  | "unverified";

export interface CfxCommandSpec {
  /** The literal command line, or a builder for one that takes an argument. */
  command: string;
  label: string;
  confidence: CommandConfidence;
  /** Why it is believed to do what the label says. */
  note?: string;
  /** True when running it changes instrument state rather than just reporting it. */
  actuates?: boolean;
}

/**
 * The action commands a client might reasonably offer as a button, with their provenance.
 *
 * Queries are not listed here — they are ordinary calls on {@link CfxDevice} and their results are
 * typed. This list exists for the ones that *do* something.
 */
export type CfxCommandName = "indicator" | "lidOpen" | "lidClose" | "cancel";

/**
 * Annotated as a plain `Record`, deliberately — not `as const satisfies`.
 *
 * Inferring the entries would narrow each `confidence` to the literal it holds today, and with
 * every command currently `"observed"` a `=== "unverified"` test elsewhere becomes provably false
 * and TypeScript rejects it as dead code. That is technically correct and exactly wrong here: that
 * test is what makes an unverified command announce itself in the UI when one is added, so it has
 * to keep compiling while none exists. The name union above is spelled out for the same reason —
 * it's the one thing `keyof typeof` was buying.
 */
export const CFX_COMMANDS: Record<CfxCommandName, CfxCommandSpec> = {
  indicator: {
    command: "BLOCKID 1",
    label: "Flash indicator",
    confidence: "observed",
    note:
      "usb.md §3 — 'block identify', the function that flashes a block's indicator so an operator " +
      "can tell which unit is being addressed. The argument is the block number; BLOCKCOUNT? " +
      "reports how many exist (1 on a CFX96).",
    actuates: true,
  },
  lidOpen: {
    command: "LID OPEN",
    label: "Open lid",
    confidence: "observed",
    note: "usb.md §3.",
    actuates: true,
  },
  lidClose: {
    command: "LID CLOSE",
    label: "Close lid",
    confidence: "observed",
    note: "usb.md §3.",
    actuates: true,
  },
  cancel: {
    command: "CANCEL",
    label: "Cancel run",
    confidence: "observed",
    note:
      "usb.md §3 — seen once, as normal run-finished cleanup rather than a user abort, so its " +
      "effect on a run still in progress is inferred rather than measured.",
    actuates: true,
  },
};
