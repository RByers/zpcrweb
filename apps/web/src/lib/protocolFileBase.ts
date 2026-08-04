/**
 * A filename base for a protocol download: the protocol's own name when it has one, else the
 * source file's name without its extension. Punctuation a filesystem might object to is
 * flattened to `_` — shipped protocol names are free-form strings and some carry slashes.
 *
 * Split out of the old `lib/protocolSource.ts` (removed with the staging/override machinery it
 * existed for) since `ProtocolView`'s download/clone buttons are its only remaining caller.
 */
export function protocolFileBase(protocolName: string | null | undefined, fileName: string): string {
  const base = protocolName?.trim() || fileName.replace(/\.[^.]+$/, "");
  return base.replace(/[\\/:*?"<>|]+/g, "_") || "protocol";
}
