import type { ProtocolStep } from "@zpcrweb/core";

/** Human-readable text for one step, GOTO-target-friendly (`Step N` matches `stepNumber`). */
function stepSummary(step: ProtocolStep): string {
  switch (step.kind) {
    case "temperature":
      return `Hold ${step.tempC}°C for ${step.holdSeconds}s`;
    case "gradient":
      return `Gradient ${step.lowTempC}–${step.highTempC}°C for ${step.holdSeconds}s`;
    case "melt":
      return (
        `Melt ${step.startTempC}°C → ${step.endTempC ?? "?"}°C, ` +
        `+${step.incrementC}°C/step, hold ${step.holdSeconds}s`
      );
    case "goto":
      return `Goto step ${step.targetStep}, repeat ${step.repeats}× more (${step.repeats + 1} total passes)`;
  }
}

/**
 * A numbered thermal-protocol step table — shared by the Overview tab and the raw `.prcl`/
 * `.pcrd` decoded view, so both render the same structured `protocol2` step list the same way.
 */
export function ProtocolStepsTable({ steps }: { steps: ProtocolStep[] }) {
  return (
    <table className="decoded__tbl mono">
      <thead>
        <tr>
          <th>#</th>
          <th>Step</th>
          <th>Read</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr key={step.stepNumber}>
            <td>{step.stepNumber}</td>
            <td style={{ textAlign: "left", whiteSpace: "normal" }}>{stepSummary(step)}</td>
            <td>{step.kind !== "goto" && step.plateRead ? "●" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
