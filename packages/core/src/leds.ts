import type { PlateReadLed } from "./types.js";
import type { IcffEntry } from "./icff.js";

/**
 * LED drive-current extraction from a `.Plateread` descriptor dictionary.
 *
 * Like `temps.ts`, nothing here is hardcoded to a known field list: **every** dictionary field
 * whose name starts with `LEDCURRENT` is extracted, so a firmware emitting more (or fewer) than
 * the six the observed CFX96 does surfaces without a code change. The values are the
 * excitation LEDs' DAC settings — `RunInfo.xml`'s `LEDDACValsCal`, one per optical channel, as
 * big-endian int32 (see `plateread.md` §3).
 *
 * They are **DAC counts, not milliamps**: the instrument stores the calibrated drive setting,
 * and nothing in the archive gives the DAC→current transfer function, so no unit conversion is
 * invented here.
 */

/**
 * Plausible DAC-count range. The observed values are 76–185 in an 8-bit-looking space; the
 * ceiling is generous enough for a wider DAC while still rejecting a float32 reinterpreted as
 * an int (which lands in the billions) or a negative.
 */
const MIN_DAC = 0;
const MAX_DAC = 65535;

/**
 * A `LEDCURRENT`-family field with a trailing 1-based channel number, e.g. `LEDCURRENT03` →
 * channel index 2. The number is the only thing tying a current to an optical channel — the
 * fields sit in channel order in the file, but the name is the authoritative link.
 */
const INDEXED_RE = /^LEDCURRENT0*(\d+)$/;

/**
 * Human label for an LED-current field: the channel it drives, in the same `Ch1`–`Ch6` form the
 * rest of the app names channels by (fluorescence curves, dark curves). A field whose name
 * carries no channel number keeps its raw name, so an unknown field is still readable.
 */
export function ledLabel(name: string): string {
  const channel = ledChannel(name);
  return channel === undefined ? name : `Ch${channel + 1}`;
}

/**
 * The 0-based optical channel an LED-current field drives, or undefined if the name carries no
 * channel number.
 */
export function ledChannel(name: string): number | undefined {
  const m = INDEXED_RE.exec(name);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n - 1 : undefined;
}

/**
 * Extract every LED drive current in a plateread's descriptor dictionary, in file order.
 *
 * @param fields the parsed descriptor dictionary
 */
export function extractLeds(fields: IcffEntry[]): PlateReadLed[] {
  const leds: PlateReadLed[] = [];
  for (const field of fields) {
    if (!field.name.startsWith("LEDCURRENT")) continue;
    if (field.length !== 4) continue;
    const { int } = field;
    if (int == null || !Number.isInteger(int) || int < MIN_DAC || int > MAX_DAC) continue;
    leds.push({
      key: field.name,
      label: ledLabel(field.name),
      channel: ledChannel(field.name),
      dac: int,
    });
  }
  return leds;
}
