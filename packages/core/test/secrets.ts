import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = resolve(here, "../../../secrets.json");

/**
 * The shared CFX ZipCrypto password, from the local, gitignored `secrets.json` (see
 * `pltd.md` §2 for what it's for and how to obtain it). Returns `undefined` when that file
 * isn't present, so the decryption-pipeline tests that need it can skip themselves instead of
 * failing — every other test works against the plaintext samples committed in `samples/` and
 * needs no secret at all.
 */
export function readCfxPassword(): string | undefined {
  if (!existsSync(SECRETS_PATH)) return undefined;
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, "utf-8")) as { cfxPassword?: string };
  return secrets.cfxPassword;
}
