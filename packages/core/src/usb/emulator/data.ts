/**
 * Where an emulated run's fluorescence comes from — `emulator.md` §7.
 *
 * Nothing here models optics. A plate read is **lifted from a recording**: one well's curve is
 * taken out of a real run's `Read0000N.Plateread` files and written into all 108 wells of the
 * emulated read, which is what `TODO.md` asked for ("generate the same curves for all wells") and
 * is also the only honest option — a synthetic sigmoid would be this project inventing data and
 * then testing its analysis against the invention.
 *
 * The bytes still go through {@link encodePlateRead}, so what the client downloads is a real
 * `.Plateread` with this run's cycle, step, temperatures and timestamps in its header, not a copy
 * of a file from 2023.
 *
 * **Core stays I/O-free.** The caller supplies the unpacked archive — a Node test reads it off
 * `samples/`, the browser fetches the bundled copy — and nothing here knows what a path is.
 */
import type { ZpcrArchive } from "../../archive.js";
import { isPlateReadName, plateReadNumber, CHANNELS, WELLS_PER_CHANNEL } from "../../plateread.js";
import { decodePlateReadSpec, encodePlateRead } from "../../platereadEncode.js";
import type { WellReading } from "../../types.js";

/** What the run knows about a plate read at the moment it materialises. */
export interface PlateReadContext {
  /** 1-based position among this run's plate reads — the `N` of `Read0000N.Plateread`. */
  index: number;
  /** The cycle it was taken in (the `.alf`'s repeat). */
  cycle: number;
  /** The 1-based protocol step number of the `PLATEREAD` that produced it. */
  stepNumber: number;
  blockTempC: number;
  lidTempC: number;
  sampleTempC: number;
  /** The scan mask the step carried (`usb.md` §3.1). */
  channelMask: number;
  /** Instrument-local time the read finished. */
  at: Date;
  /** The instrument's own name for the file, e.g. `Read00001.Plateread`. */
  fileName: string;
}

/**
 * Everything an emulated run needs that isn't decided by the protocol it is running.
 *
 * A thermal-only run needs none of it — it writes no run folder at all (`usb.md` §7.10) — which
 * is why {@link EmulatorOptions.data} is optional rather than there being a third, empty
 * implementation of this to pass.
 */
export interface EmulatorRunData {
  /** The `.Plateread` bytes for one read of this run. */
  plateRead(context: PlateReadContext): Uint8Array;
  /**
   * The rest of what the instrument leaves in the run folder: the `.Dcal` calibration set,
   * `RunInfo.xml` and `runlog.xml`. Carried verbatim from the recording, so they describe the
   * recorded run rather than this one — see `emulator.md` Appendix A.
   */
  supportFiles(): Record<string, Uint8Array>;
}

/** Entries the emulator takes from a recording as-is — everything else in a run folder is either
 * this run's (the reads, the markers, the report) or a host deposit that isn't the instrument's
 * to reproduce (`zpcrweb.json`, the `.plt.csv`, `usb-traffic.bin`). */
function isSupportFile(name: string): boolean {
  return /\.Dcal$/i.test(name) || name === "RunInfo.xml" || name === "runlog.xml";
}

/** One recorded read, reduced to the single well's curve the emulator replicates. */
interface RecordedRead {
  bytes: Uint8Array;
  blockTempC: number;
}

/**
 * The well whose curve every emulated well gets.
 *
 * Chosen as the one that *moves most* across the recording — summed per-channel range — rather
 * than a fixed A1, because a plate's empty wells are flat and a flat curve makes a poor test
 * subject: nothing downstream would have a Cq to compute or a melt peak to find.
 */
function liveliestWell(reads: readonly { spec: ReturnType<typeof decodePlateReadSpec> }[]): number {
  let best = 0;
  let bestRange = -1;
  for (let well = 0; well < WELLS_PER_CHANNEL; well++) {
    let range = 0;
    for (let channel = 0; channel < CHANNELS; channel++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const { spec } of reads) {
        const v = spec.readings(channel, well).mean;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      range += hi - lo;
    }
    if (range > bestRange) {
      bestRange = range;
      best = well;
    }
  }
  return best;
}

export interface RecordedRunDataOptions {
  /**
   * Which well's curve to replicate, 0-based row-major. Defaults to the liveliest one in the
   * recording — see {@link liveliestWell}.
   */
  well?: number;
}

/**
 * Build a data source from a recorded run's archive.
 *
 * Works the same for an amplification run and a melt: a melt's reads are the same files, keyed by
 * the block temperature of the step that took them rather than by cycle. Read *n* of the emulated
 * run is read *n* of the recording; past the end of the recording, the read whose block
 * temperature is nearest is used instead, so a melt emulated over a different temperature range
 * still gets the right shape rather than the last read repeated.
 */
export function recordedRunData(
  archive: ZpcrArchive,
  options: RecordedRunDataOptions = {},
): EmulatorRunData {
  const entries = Object.entries(archive)
    .filter(([name]) => isPlateReadName(name))
    .sort(([a], [b]) => (plateReadNumber(a) ?? 0) - (plateReadNumber(b) ?? 0));
  if (entries.length === 0) {
    throw new Error("this archive holds no .Plateread files, so there are no curves to lift");
  }
  const specs = entries.map(([, bytes]) => ({ spec: decodePlateReadSpec(bytes) }));
  const reads: RecordedRead[] = entries.map(([, bytes], i) => ({
    bytes,
    blockTempC: specs[i]!.spec.header.blockTempC,
  }));
  const well = options.well ?? liveliestWell(specs);

  const support: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(archive)) {
    if (isSupportFile(name)) support[name] = bytes;
  }

  const sourceFor = (index: number, atTempC: number): RecordedRead => {
    if (index >= 1 && index <= reads.length) return reads[index - 1]!;
    let best = reads[reads.length - 1]!;
    for (const read of reads) {
      if (Math.abs(read.blockTempC - atTempC) < Math.abs(best.blockTempC - atTempC)) best = read;
    }
    return best;
  };

  return {
    plateRead(context) {
      const source = decodePlateReadSpec(sourceFor(context.index, context.blockTempC).bytes);
      const curve: WellReading[] = [];
      for (let channel = 0; channel < CHANNELS; channel++) {
        curve.push(source.readings(channel, well));
      }
      return encodePlateRead({
        header: {
          ...source.header,
          scanIndex: context.index,
          step: context.stepNumber,
          cycle: context.cycle,
          blockTempC: context.blockTempC,
          lidTempC: context.lidTempC,
          sampleTempC: context.sampleTempC,
          channelMask: context.channelMask,
          // Bit 7 of the mask on its own, the same relationship every recorded read shows
          // (`usb.md` §3.1).
          scanMode: (context.channelMask & 0x80) !== 0 ? 1 : 0,
          dateTime: context.at.toUTCString(),
          // The instrument's own path for the file, with the extension it really does misspell.
          filePath: `\\Storage Card\\CurrentRun\\${context.fileName.replace(/\.Plateread$/i, ".xlateread")}`,
        },
        readings: (channel) => curve[channel]!,
        dark: (channel) => source.dark(channel),
      });
    },
    supportFiles: () => ({ ...support }),
  };
}
