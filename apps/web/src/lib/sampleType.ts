import type { SampleType } from "@zpcrweb/core";

/** Display metadata per normalized sample type: full label, accent color. */
export const SAMPLE_TYPE_META: Record<SampleType, { label: string; color: string }> = {
  unknown: { label: "Unknown", color: "#22d3ee" },
  standard: { label: "Standard", color: "#22d3ee" },
  ntc: { label: "NTC (no-template)", color: "#ef4444" },
  nrt: { label: "NRT (no-RT)", color: "#f97316" },
  positiveControl: { label: "Positive control", color: "#22c55e" },
  negativeControl: { label: "Negative control", color: "#ef4444" },
  empty: { label: "Empty / not loaded", color: "#5a6b86" },
  passiveRef: { label: "Passive reference", color: "#3b82f6" },
  custom: { label: "Custom", color: "#eab308" },
  other: { label: "Other", color: "#a855f7" },
};

export const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
