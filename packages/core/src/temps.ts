import type { PlateReadTemp, TempKind } from "./types.js";
import type { IcffEntry } from "./icff.js";

/**
 * Temperature extraction from a `.Plateread` descriptor dictionary.
 *
 * Nothing here is hardcoded to a known field list: **every** dictionary field whose name
 * contains `TEMP` is extracted, so a firmware emitting a temperature this code has never seen
 * surfaces automatically without a code change. The observed CFX96 firmware
 * (`PLATEREADVERSION 2`) emits only five measured temperatures — block, ambient, shuttle,
 * sample, lid — plus the two fan set points; see `plateread.md` §3. There are no per-row or
 * per-zone block temperatures, not even in a gradient run (`plateread.md` §3).
 */

/** Plausible instrument temperature range in °C — used to tell floats from set-point ints. */
const MIN_C = -50;
const MAX_C = 200;
/**
 * Smallest non-zero magnitude accepted as a real float32 temperature. An int32 set point
 * like `35` reinterpreted as a float32 is a denormal (~4.9e-44), which is numerically inside
 * the plausible range; anything under a millidegree is that, not a reading.
 */
const MIN_FLOAT_MAGNITUDE = 1e-3;

/** Friendly labels for the field names observed in CFX96 platereads. */
const KNOWN_LABELS: Record<string, string> = {
  BLOCKTEMP: "Block",
  AMBIENTTEMP: "Ambient",
  SHUTTLETEMP: "Shuttle",
  SAMPLETEMP: "Sample",
  LIDTEMP: "Lid",
  FANOFFTEMP: "Fan off at",
  FANONTEMP: "Fan on at",
};

/** Field names that are configured thresholds rather than measurements. */
const SETPOINT_NAMES = new Set(["FANOFFTEMP", "FANONTEMP"]);

/** Title-case a bare field stem, e.g. `SHUTTLE` → `Shuttle`. */
function titleCase(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Human label for an arbitrary `*TEMP*` field name. Known names get their curated label;
 * anything else is derived (`HEATSINKTEMP` → `Heatsink`) so unknown fields are still readable
 * in the UI.
 */
export function tempLabel(name: string): string {
  const known = KNOWN_LABELS[name];
  if (known) return known;
  const stem = name.replace(/TEMPERATURE$/, "").replace(/TEMP$/, "");
  return stem ? titleCase(stem) : "Temp";
}

/**
 * Decode one field's temperature value, or `undefined` if it does not look like one.
 *
 * The dictionary stores measured temperatures as big-endian float32 and the fan set points
 * as big-endian int32, with no type tag distinguishing them (the tag is 1 for everything).
 * They are told apart by plausibility: a set point like `35` reads as a float32 denormal
 * (~4.9e-44), and a measured `59.99` reads as an int in the billions, so at most one of the
 * two interpretations ever lands in {@link MIN_C}–{@link MAX_C}.
 */
function decodeTemp(
  field: IcffEntry,
): { celsius: number; kind: TempKind } | undefined {
  if (field.length !== 4) return undefined;
  const setpoint = SETPOINT_NAMES.has(field.name);
  const { float, int } = field;
  const floatPlausible =
    float != null &&
    Number.isFinite(float) &&
    float > MIN_C &&
    float < MAX_C &&
    (float === 0 || Math.abs(float) >= MIN_FLOAT_MAGNITUDE);
  if (floatPlausible) {
    return { celsius: float, kind: setpoint ? "setpoint" : "measured" };
  }
  if (int != null && int > MIN_C && int < MAX_C) {
    return { celsius: int, kind: setpoint ? "setpoint" : "measured" };
  }
  return undefined;
}

/**
 * Extract every temperature in a plateread's descriptor dictionary, in file order.
 *
 * @param fields the parsed descriptor dictionary
 */
export function extractTemps(fields: IcffEntry[]): PlateReadTemp[] {
  const temps: PlateReadTemp[] = [];
  for (const field of fields) {
    if (!field.name.includes("TEMP")) continue;
    const decoded = decodeTemp(field);
    if (!decoded) continue;
    temps.push({
      key: field.name,
      label: tempLabel(field.name),
      celsius: decoded.celsius,
      kind: decoded.kind,
    });
  }
  return temps;
}
