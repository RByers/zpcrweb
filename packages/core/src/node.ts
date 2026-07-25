import type { Zpcr } from "./types.js";
import { parseZpcr } from "./zpcr.js";
import { parsePcrd, type Pcrd, type PcrdOptions } from "./pcrd.js";

/**
 * Node-only convenience: read a `.zpcr` file from disk and parse it. Uses a dynamic import
 * of `node:fs/promises` so this module can be bundled for the browser without pulling in
 * Node built-ins (browser consumers simply never call this).
 */
export async function zpcrFromFile(path: string): Promise<Zpcr> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(path);
  return parseZpcr(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
}

/** Node-only convenience: read a `.pcrd` file from disk and parse it. See {@link zpcrFromFile}. */
export async function pcrdFromFile(path: string, options?: PcrdOptions): Promise<Pcrd> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(path);
  return parsePcrd(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), options);
}
