/**
 * Turning a person's words into a file name.
 *
 * Names in this app come from people and from instruments: an experiment called `RVP "fast"/v2`,
 * a plate whose identity is `S183-S185 RVP v2.1`, a protocol named `95°C / 30s`. Those strings
 * end up as file names on a disk, as entry names inside a `.zpcr`, as `Content-Disposition`
 * filenames on a download, and as operands of the instrument's own `RemoteRun` command — four
 * consumers with four different sets of characters they choke on, and no way to know in advance
 * which one a given name will reach.
 *
 * So this module does not enumerate what breaks. It enumerates what works: **`A-Za-z0-9`, `_` and
 * `-`, and nothing else.** Everything outside that becomes `_`. An allow-list is the only rule
 * that stays correct when a name reaches a consumer nobody thought about — the previous
 * per-caller deny-lists (`[\\/:*?"<>|]`) each let through `#`, `%`, `&`, `$`, backticks and
 * spaces, which are variously a URL fragment, a shell glob, a Windows-hostile trailing space, or
 * simply noise in a name meant to be typed back.
 *
 * Deliberately **not** allowed:
 *
 * - **`.`** — a dot inside a base name manufactures an extension that isn't one, and every
 *   caller here appends the real extension itself. `S183-S185 RVP v2.1` becomes
 *   `S183-S185_RVP_v2_1`, so `…v2_1.plt.csv` splits the way `cloneName.ts` and
 *   `experiment.ts`'s `stripExtension` expect.
 * - **space** — a name is round-tripped back to a display name by turning `_` into a space
 *   (`experiment.ts`'s `deriveExperimentName`), so a literal space would be a second spelling of
 *   the same thing, and it is the character most likely to be mangled in transit anyway.
 *
 * Accented letters are folded to their base letter rather than dropped (`Réplica` →
 * `Replica`), because `R_plica` loses a word the person can still read.
 */

/**
 * `name` reduced to `A-Za-z0-9_-`: accents folded, every other character `_`, runs of `_`
 * collapsed, leading and trailing `_` removed.
 *
 * Returns `""` when nothing survives — a name that was entirely punctuation, or was empty to
 * begin with. Callers supply their own fallback for that case, since the right one differs
 * ("run", "plate", "protocol", the instrument's `zpcrweb`).
 */
export function safeFileBase(name: string): string {
  return (
    name
      .normalize("NFKD")
      // Combining marks left behind by the decomposition above — the accent, now that the base
      // letter has been split off it.
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      // Two adjacent replacements (`RVP "fast"` → `RVP__fast_`) read as a typo rather than as a
      // name. Nothing reads them back individually — a `_` is a space to `deriveExperimentName`
      // however many there were.
      .replace(/_{2,}/g, "_")
      .replace(/^_+|_+$/g, "")
  );
}
