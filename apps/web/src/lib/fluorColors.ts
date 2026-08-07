/**
 * Fluorophore → color, for dye chips, plate well dots, target chips and dye-space curves.
 *
 * A dye's color is a property of the **dye**, not of the instrument that read it — FAM is green
 * because FAM emits green — so nothing here consults an optical channel. `channelColors.ts` still
 * owns color for genuine channel-space views (raw `.Plateread` tables, the reference-calibration
 * panel, per-channel curve rows), where the question really is "which filter saw this?".
 *
 * The table, and the reasoning behind it, live in `@zpcrweb/core`'s `colors.ts` so the CLI
 * (`tools/zpcr.mjs`) draws the same curves in the same colors; this module is the app's import
 * path for them.
 */

export { fluorColor, isKnownFluor, curveColor } from "@zpcrweb/core";
