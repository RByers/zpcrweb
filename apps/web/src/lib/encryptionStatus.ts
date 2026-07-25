import type { RunResult, PlateFileResult } from "../state/useZpcrStore";

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
 * Encryption status for a `.zpcr`/`.pcrd` run. A `.pcrd` is itself one encrypted document (its
 * own `container.encrypted`); a `.zpcr`'s outer archive is never encrypted, so its status
 * instead comes from whichever embedded `.pltd`/`.prcl` entries are ZipCrypto-encrypted.
 */
export function runEncryptionStatus(run: RunResult | undefined, password: string): EncryptionStatus {
  if (!run) return { kind: "none" };

  if (run.container) {
    if (!run.container.encrypted) return { kind: "none" };
    return run.zpcr ? { kind: "decrypted", password } : { kind: "locked" };
  }

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
