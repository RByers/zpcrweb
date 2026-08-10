import { safeFileBase } from "@zpcrweb/core";

/**
 * A filename base for a protocol download: the protocol's own name when it has one, else the
 * source file's name without its extension, reduced to `A-Za-z0-9_-` by core's `safeFileBase` —
 * shipped protocol names are free-form strings and some carry slashes.
 *
 * Split out of the old `lib/protocolSource.ts` (removed with the staging/override machinery it
 * existed for) since `ProtocolView`'s download/clone buttons are its only remaining caller.
 */
export function protocolFileBase(protocolName: string | null | undefined, fileName: string): string {
  const base = protocolName?.trim() || fileName.replace(/\.[^.]+$/, "");
  return safeFileBase(base) || "protocol";
}
