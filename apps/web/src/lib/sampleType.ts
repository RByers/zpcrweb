import type { SampleType } from "@zpcrweb/core";

/** Display metadata per normalized sample type: short badge, full label, accent color. */
export const SAMPLE_TYPE_META: Record<SampleType, { abbr: string; label: string; color: string }> = {
  unknown: { abbr: "Unk", label: "Unknown", color: "#22d3ee" },
  standard: { abbr: "Std", label: "Standard", color: "#22d3ee" },
  ntc: { abbr: "NTC", label: "NTC (no-template)", color: "#ef4444" },
  nrt: { abbr: "NRT", label: "NRT (no-RT)", color: "#f97316" },
  positiveControl: { abbr: "Pos", label: "Positive control", color: "#22c55e" },
  negativeControl: { abbr: "Neg", label: "Negative control", color: "#ef4444" },
  empty: { abbr: "·", label: "Empty / not loaded", color: "#5a6b86" },
  passiveRef: { abbr: "Ref", label: "Passive reference", color: "#3b82f6" },
  custom: { abbr: "Cus", label: "Custom", color: "#eab308" },
  other: { abbr: "?", label: "Other", color: "#a855f7" },
};

export const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
