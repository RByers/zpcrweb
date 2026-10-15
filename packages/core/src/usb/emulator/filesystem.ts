/**
 * The instrument's filesystem — `emulator.md` §4, `usb.md` §5.
 *
 * A flat path→bytes map over the directories `\Storage Card` is known to hold (`CurrentRun`,
 * `PCRunReport`, `Real-Time Data` and `Logs` — see `EmulatedInstrument`'s constructor). What
 * makes it worth a module of its own is that two of its behaviours are **measured quirks a client
 * has to cope with**, and an emulator that tidied them away would be testing the client against a
 * filesystem nobody has:
 *
 * - **`LISTALLFILES` ignores its own path argument** and replays whatever the preceding
 *   `GETFILESLEN` buffered — a buffer that survives a disconnect, since it lives on the
 *   instrument. That is why listing is an atomic pair in `CfxDevice.listFiles`, and this is the
 *   thing that proves it.
 * - **`GETFILESLEN` answers some paths with four raw bytes instead of a length** — `07 00 09 00`
 *   for a directory holding no files, `04 00 09 00` for no such directory — carried as a
 *   `passThrough` message rather than the usual `<value>;<code>` text.
 *
 * Listings cover **files only**, so `\Storage Card`, which holds nothing but subdirectories,
 * answers "empty" rather than naming them.
 */

/** `GETFILESLEN`: the directory exists but holds no files (`usb.md` §5). */
export const LISTING_EMPTY = new Uint8Array([0x07, 0x00, 0x09, 0x00]);
/** `GETFILESLEN`: no such directory — including a path that names a file (`usb.md` §5). */
export const LISTING_MISSING = new Uint8Array([0x04, 0x00, 0x09, 0x00]);
/** `DELFILE`: no such file. Not an error — a first upload to a clean directory always gets it
 * (`usb.md` §7.4). */
export const FILE_MISSING = new Uint8Array([0x05, 0x00, 0x09, 0x00]);

/** What `GETFILESLEN` had to say: a listing length, or one of the binary status codes. */
export type ListingLength =
  | { kind: "length"; value: number }
  | { kind: "binary"; bytes: Uint8Array };

/**
 * Reduce a path to its lookup key. Measured (`usb.md` §5): quoting, a trailing separator,
 * forward slashes and case all make no difference to the instrument, so none of them may make a
 * difference here either — a client that only works against one spelling would pass against a
 * stricter emulator and fail in the lab.
 */
function key(path: string): string {
  return path
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/** The directory half of a path, as the instrument spells it back. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("\\");
  return cut <= 0 ? "" : path.slice(0, cut);
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("\\") + 1);
}

export class EmulatorFilesystem {
  /** Full path (as written) → contents, keyed by {@link key}. */
  private readonly files = new Map<string, { path: string; bytes: Uint8Array }>();
  /** Directories that exist. A path outside this set is "no such directory". */
  private readonly dirs = new Set<string>();
  /**
   * The listing `GETFILESLEN` last computed. `LISTALLFILES` replays it whatever path it is given,
   * and it outlives a USB disconnect — the buffer is the instrument's, not the session's.
   */
  private buffered: string | null = null;
  /** The transient GUID copy the last `CRCSENDFILE` was stored under (`usb.md` §5, step 3). */
  private staged: { path: string; bytes: Uint8Array } | null = null;

  constructor(directories: readonly string[]) {
    for (const dir of directories) this.dirs.add(key(dir));
  }

  /** Put a file in place, creating nothing: the directory must already exist. */
  write(path: string, bytes: Uint8Array): void {
    this.files.set(key(path), { path, bytes });
  }

  /**
   * {@link write}, for a file placed before the session starts — which is a test's or a mock
   * session's setup rather than anything the instrument did, so a typo'd directory is an error
   * here instead of a file no listing will ever show.
   */
  seed(path: string, bytes: Uint8Array): void {
    if (!this.dirs.has(key(parentOf(path)))) {
      throw new Error(`can't seed ${path}: the instrument has no directory ${parentOf(path)}`);
    }
    this.write(path, bytes);
  }

  read(path: string): Uint8Array | null {
    return this.files.get(key(path))?.bytes ?? null;
  }

  /** Remove a file. False when there was none — `DELFILE`'s `05 00 09 00` case. */
  delete(path: string): boolean {
    return this.files.delete(key(path));
  }

  /** Every file directly inside `dir`, in the order they were written. */
  names(dir: string): string[] {
    const want = key(dir);
    const out: string[] = [];
    for (const { path } of this.files.values()) {
      if (key(parentOf(path)) === want) out.push(baseOf(path));
    }
    return out;
  }

  /** Remove every file in `dir`, and report what went. */
  clear(dir: string): string[] {
    const gone = this.names(dir);
    for (const name of gone) this.delete(`${dir}\\${name}`);
    return gone;
  }

  /**
   * `GETFILESLEN <dir>` — the byte length of the listing, **and** the call that buffers it.
   *
   * A directory with no files in it, and a path that is not a directory at all, answer with their
   * binary status code instead and leave the previous buffer untouched — which is exactly the
   * state that makes sending `LISTALLFILES` anyway return another directory's contents.
   */
  getFilesLen(path: string): ListingLength {
    if (!this.dirs.has(key(path))) return { kind: "binary", bytes: LISTING_MISSING };
    const listing = this.names(path).join(",");
    if (listing === "") return { kind: "binary", bytes: LISTING_EMPTY };
    this.buffered = listing;
    return { kind: "length", value: listing.length };
  }

  /** `LISTALLFILES <anything>` — the buffered listing, whatever path it was asked about. */
  listAllFiles(): string {
    return this.buffered ?? "";
  }

  /**
   * `CRCSENDFILE` — store the file under its friendly name, and under a generated GUID name
   * besides. `COMPUTEFILECRC` hands that GUID path back and `GETFILECRC` is asked about it; it is
   * gone by the next upload, which is what the capture shows (`usb.md` §7.4).
   */
  receive(path: string, bytes: Uint8Array, guid: string): void {
    if (this.staged) this.files.delete(key(this.staged.path));
    this.write(path, bytes);
    const stagedPath = `${parentOf(path)}\\${guid}`;
    this.staged = { path: stagedPath, bytes };
    this.write(stagedPath, bytes);
  }

  /** The GUID path the last {@link receive} stored under, or null if nothing has been uploaded. */
  get stagedPath(): string | null {
    return this.staged?.path ?? null;
  }
}
