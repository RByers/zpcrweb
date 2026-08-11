import type { RunResult, PlateFileResult, ProtocolFileResult } from "../state/useZpcrStore";

/**
 * Whether a loaded file (or something inside it) is encrypted, and if so, whether it's been
 * successfully decrypted with the current password:
 * - `"none"`: nothing in the file is encrypted.
 * - `"decrypted"`: encrypted, and the current password opened it.
 * - `"locked"`: encrypted, and it hasn't been opened (no/wrong password, or another decode
 *   failure) — no plaintext is available.
 */
export type EncryptionStatus =
  | { kind: "none" }
  | { kind: "decrypted"; password: string }
  | { kind: "locked" };

/**
 * Encryption status for a run. Asked and answered without naming a format: a run that is *itself*
 * an encrypted container ({@link RunResult.selfEncrypted} — in practice a `.pcrd`) is decrypted
 * exactly when it produced a `Zpcr`; any other run's status comes from whichever embedded
 * `.pltd`/`.prcl` entries are ZipCrypto-encrypted, of which an unencrypted run simply has none.
 */
export function runEncryptionStatus(run: RunResult | undefined, password: string): EncryptionStatus {
  if (!run) return { kind: "none" };

  if (run.selfEncrypted) return run.zpcr ? { kind: "decrypted", password } : { kind: "locked" };

  if (!run.zpcr) return run.needsPassword || run.error ? { kind: "locked" } : { kind: "none" };

  const entries = [
    ...run.zpcr.plates(password || undefined).map((p) => p.pltd),
    ...run.zpcr.protocols(password || undefined).map((p) => p.prcl),
  ];
  const encrypted = entries.filter((e) => e.container.encrypted);
  if (encrypted.length === 0) return { kind: "none" };
  const locked = encrypted.some((e) => e.needsPassword || e.error);
  return locked ? { kind: "locked" } : { kind: "decrypted", password };
}

/** Encryption status for a standalone `.pltd`/`.csv` plate file (a `.csv` is never encrypted). */
export function plateFileEncryptionStatus(
  plateFile: PlateFileResult | undefined,
  password: string,
): EncryptionStatus {
  if (!plateFile?.container?.encrypted) return { kind: "none" };
  return plateFile.plate ? { kind: "decrypted", password } : { kind: "locked" };
}

/**
 * Encryption status for a standalone `.prcl`/`.prcl.txt` protocol file — the protocol-side
 * counterpart of {@link plateFileEncryptionStatus}, and the same shape of answer, because the
 * container is literally the same one (`zipcrypto.md`).
 *
 * A `.prcl.txt` has no container and answers "none", as does the bare-text `.prcl` variant
 * (`prcl.md` §1.1): both are protocols nobody encrypted, and the question is about the bytes on
 * disk rather than about the extension.
 */
export function protocolFileEncryptionStatus(
  protocolFile: ProtocolFileResult | undefined,
  password: string,
): EncryptionStatus {
  if (!protocolFile?.container?.encrypted) return { kind: "none" };
  return protocolFile.runDefinition ? { kind: "decrypted", password } : { kind: "locked" };
}
