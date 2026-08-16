import type { SampleType } from "@zpcrweb/core";

/**
 * Display metadata per normalized sample type: full label, accent color, and a `short` code for
 * places too narrow for the label — the Curves rail's per-type well selectors, which sit in the
 * "Wells" heading row beside the grid they filter. The short codes are the instrument's own
 * vocabulary where it has one (NTC, NRT) and a plain abbreviation where it doesn't; the full
 * label always rides along as the button's tooltip, so nothing is only ever said in shorthand.
 *
 * The key order here is the order those selectors appear in, so it reads controls-first
 * (unknown/standard, then the controls, then the odds and ends).
 */
export const SAMPLE_TYPE_META: Record<
  SampleType,
  { label: string; short: string; color: string }
> = {
  unknown: { label: "Unknown", short: "Unk", color: "#22d3ee" },
  standard: { label: "Standard", short: "Std", color: "#22d3ee" },
  ntc: { label: "NTC (no-template)", short: "NTC", color: "#ef4444" },
  nrt: { label: "NRT (no-RT)", short: "NRT", color: "#f97316" },
  positiveControl: { label: "Positive control", short: "Pos", color: "#22c55e" },
  negativeControl: { label: "Negative control", short: "Neg", color: "#ef4444" },
  empty: { label: "Empty / not loaded", short: "Empty", color: "#5a6b86" },
  passiveRef: { label: "Passive reference", short: "Ref", color: "#3b82f6" },
  custom: { label: "Custom", short: "Cust", color: "#eab308" },
  other: { label: "Other", short: "Other", color: "#a855f7" },
};

export const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
