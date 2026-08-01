import { describeProtocolStep, type ProtocolStep } from "@zpcrweb/core";

/**
 * A numbered thermal-protocol step table — shared by the Overview tab and the raw `.prcl`/
 * `.pcrd` decoded view, so both render the same structured `protocol2` step list the same way.
 *
 * What a step *means* comes from the library (`describeProtocolStep`), the same way the text
 * form's per-directive readings do — see `protocol.md`.
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
            <td style={{ textAlign: "left", whiteSpace: "normal" }}>
              {describeProtocolStep(step)}
            </td>
            <td>{step.kind !== "goto" && step.plateRead ? "\u25cf" : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
