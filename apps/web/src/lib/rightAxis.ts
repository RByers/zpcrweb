import type { LedCurve, TemperatureCurve } from "@zpcrweb/core";
import { channelColor } from "./channelColors";
import { tempColor } from "./tempColors";
import type { AuxAxis, AuxCurve } from "./uplot/chart";

/**
 * The chart's right-hand axis: instrument context plotted against the amplification curves.
 *
 * There is exactly **one** right axis, and two things can occupy it — the platereads'
 * temperatures or their LED drive currents. They are deliberately mutually exclusive rather
 * than given an axis each: °C and DAC counts share no scale, and a second right axis would eat
 * plot width and force the reader to check which axis a dashed line belongs to. Enabling one
 * clears the other (see `useZpcrStore`'s `updateSettings`).
 *
 * Both reduce to the format-agnostic {@link AuxCurve} the chart draws, so the chart itself
 * knows nothing about temperatures or LEDs — only that some series ride the right scale.
 */

/** Which series occupy the right axis. `"none"` means the axis is hidden. */
export type RightAxisKind = "none" | "temps" | "leds";

const EMPTY: AuxAxis = {
  label: "",
  unit: "",
  rowLabel: "",
  decimals: 1,
  tipDecimals: 1,
  curves: [],
};

/** The right axis for a set of temperature series (empty in → hidden axis). */
export function temperatureAxis(temps: TemperatureCurve[]): AuxAxis {
  if (temps.length === 0) return EMPTY;
  return {
    label: "Temperature (°C)",
    unit: "°C",
    rowLabel: "temp",
    decimals: 1,
    tipDecimals: 2,
    curves: temps.map(
      (t, i): AuxCurve => ({
        key: t.key,
        label: t.label,
        color: tempColor(i, t.kind),
        setpoint: t.kind === "setpoint",
        cycles: t.cycles,
        values: t.celsius,
      }),
    ),
  };
}

/**
 * The right axis for a set of LED drive-current series (empty in → hidden axis).
 *
 * Unlike temperatures — which are kept off the dye palette on purpose (see `tempColors.ts`) —
 * an LED current *is* a property of one optical channel, so it borrows that channel's hue: the
 * dashed `Ch3` LED line and the solid `Ch3` well curves being the same color is the point. The
 * axis is labelled in DAC counts and every series is named in the rail and the tooltip, so the
 * shared hue can't be mistaken for a fluorescence reading.
 */
export function ledAxis(leds: LedCurve[]): AuxAxis {
  if (leds.length === 0) return EMPTY;
  return {
    label: "LED current (DAC)",
    unit: "DAC",
    rowLabel: "LED",
    decimals: 0,
    tipDecimals: 0,
    curves: leds.map(
      (l): AuxCurve => ({
        key: l.key,
        label: l.label,
        color: channelColor(l.channel),
        cycles: l.cycles,
        values: l.dac,
      }),
    ),
  };
}

/**
 * The same axis narrowed to the series whose keys are enabled. The full axis is built first so a
 * series' color doesn't shift as its neighbours are toggled (temperature colors are positional —
 * see `tempColors.ts`), which also keeps the rail's chips and the plotted lines in agreement.
 */
export function selectAux(axis: AuxAxis, enabled: Set<string>): AuxAxis {
  return { ...axis, curves: axis.curves.filter((c) => enabled.has(c.key)) };
}

/** No right axis at all — what a chart with no instrument context passes. */
export function noRightAxis(): AuxAxis {
  return EMPTY;
}
