/**
 * The verb-specific form behind one row of the protocol editor: one labelled line per operand,
 * with its units shown beside the field and fixed.
 *
 * Nothing here writes protocol text. A form edits a {@link ProtocolStepDraft} (or the
 * {@link ProtocolHeaderDraft}), core's `ProtocolBuilder` turns that into directives, and the
 * limits and error messages beside each field are core's too (`validateStepDraft`,
 * `PROTOCOL_LIMITS` — `protocol.md` §3.5). That is what keeps "what a `GRAD` may hold" a fact
 * about the language rather than a fact about this component.
 */

import { useMemo, type ReactNode } from "react";
import {
  PROTOCOL_LIMITS,
  PROTOCOL_METHODS,
  PROTOCOL_STEP_KINDS,
  validateProtocolHeader,
  validateStepDraft,
  type ProtocolHeaderDraft,
  type ProtocolIssue,
  type ProtocolStepDraft,
  type ProtocolStepKind,
  type ScanSelection,
} from "@zpcrweb/core";

/** What each step kind is called in the UI — the verb, plus what it does in a couple of words. */
export const STEP_KIND_LABELS: Record<ProtocolStepKind, string> = {
  temp: "TEMP — hold a temperature",
  grad: "GRAD — gradient across the block",
  plateread: "PLATEREAD — read the plate",
  goto: "GOTO — loop back",
  melt: "MELT — melt curve",
};

/** One labelled line: a control, then its units, which the user never edits. */
function Line({
  label,
  units,
  error,
  children,
}: {
  label: string;
  units?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className={"stepform__line" + (error ? " is-invalid" : "")}>
      <span className="stepform__label">{label}</span>
      <span className="stepform__control">{children}</span>
      <span className="stepform__units">{units ?? ""}</span>
      {error && <span className="stepform__error">{error}</span>}
    </label>
  );
}

/** A number field. Empty means "absent" when `optional`, which is how a modifier is removed. */
function NumberLine({
  label,
  units,
  value,
  onChange,
  error,
  step = "any",
  optional = false,
  placeholder,
}: {
  label: string;
  units: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  error?: string | undefined;
  step?: string;
  optional?: boolean;
  placeholder?: string;
}) {
  return (
    <Line label={label} units={units} error={error}>
      <input
        type="number"
        className="stepform__input mono"
        step={step}
        value={value === undefined ? "" : String(value)}
        placeholder={placeholder ?? (optional ? "none" : "")}
        onInput={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value.trim();
          if (raw === "") onChange(optional ? undefined : NaN);
          else onChange(Number(raw));
        }}
      />
    </Line>
  );
}

function SelectLine<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  error?: string | undefined;
}) {
  return (
    <Line label={label} error={error}>
      <select
        className="stepform__input stepform__select"
        value={value}
        onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Line>
  );
}

/** The two fields a scan mask actually holds (`usb.md` §3.1) — never the hex byte itself. */
function ScanLines({
  scan,
  onChange,
}: {
  scan: ScanSelection;
  onChange: (s: ScanSelection) => void;
}) {
  return (
    <>
      <SelectLine
        label="Channels"
        value={scan.channels}
        onChange={(channels) => onChange({ ...scan, channels })}
        options={[
          { value: "all6" as const, label: "All 6 channels" },
          { value: "ch1" as const, label: "Channel 1 only" },
        ]}
      />
      <SelectLine
        label="Scan mode"
        value={scan.flyover ? "flyover" : "step"}
        onChange={(v) => onChange({ ...scan, flyover: v === "flyover" })}
        options={[
          { value: "step" as const, label: "Step-and-repeat" },
          { value: "flyover" as const, label: "Flyover (continuous)" },
        ]}
      />
    </>
  );
}

const errorFor = (issues: ProtocolIssue[], field: string): string | undefined =>
  issues.find((i) => i.field === field)?.message;

/** The header's three directives — `METHOD`, `HOTLID`, `VOLUME` (`protocol.md` §3.2). */
export function HeaderForm({
  header,
  onChange,
}: {
  header: ProtocolHeaderDraft;
  onChange: (h: ProtocolHeaderDraft) => void;
}) {
  const issues = useMemo(() => validateProtocolHeader(header), [header]);
  return (
    <div className="stepform">
      <SelectLine
        label="Method"
        value={header.method}
        onChange={(method) => onChange({ ...header, method })}
        options={PROTOCOL_METHODS.map((m) => ({
          value: m,
          label:
            m === "CALC"
              ? "CALC — calculated sample temperature"
              : m === "BLOCK"
                ? "BLOCK — block temperature"
                : "OTHER",
        }))}
        error={errorFor(issues, "method")}
      />
      <NumberLine
        label="Lid temperature"
        units="°C (0 = off)"
        value={header.lidTemperatureC}
        step="1"
        onChange={(v) => onChange({ ...header, lidTemperatureC: v ?? NaN })}
        error={errorFor(issues, "lidTemperatureC")}
      />
      <NumberLine
        label="Lid off below"
        units="°C"
        value={header.shutoffTemperatureC}
        step="1"
        onChange={(v) => onChange({ ...header, shutoffTemperatureC: v ?? NaN })}
        error={errorFor(issues, "shutoffTemperatureC")}
      />
      <NumberLine
        label="Sample volume"
        units="µL"
        value={header.volumeUl}
        step="1"
        onChange={(v) => onChange({ ...header, volumeUl: v ?? NaN })}
        error={errorFor(issues, "volumeUl")}
      />
    </div>
  );
}

/**
 * One step's operands. `legalTargets` is what a `GOTO` may point at
 * (`ProtocolBuilder.legalGotoTargets`) and `targetLabels` describes each of those steps, so the
 * loop is picked by what it returns to rather than by a bare number.
 */
export function StepForm({
  step,
  onChange,
  legalTargets,
  targetLabels,
  onKindChange,
}: {
  step: ProtocolStepDraft;
  onChange: (s: ProtocolStepDraft) => void;
  legalTargets: readonly number[];
  targetLabels: Map<number, string>;
  /** Offered as the form's first line, so a step can be changed from one verb to another. */
  onKindChange?: (kind: ProtocolStepKind) => void;
}) {
  const issues = useMemo(
    () => validateStepDraft(step, undefined, legalTargets),
    [step, legalTargets],
  );
  const err = (field: string) => errorFor(issues, field);

  return (
    <div className="stepform">
      {onKindChange && (
        <SelectLine
          label="Step"
          value={step.kind}
          onChange={onKindChange}
          options={PROTOCOL_STEP_KINDS.filter(
            // A GOTO with nothing to return to has no valid text at all (`protocol.md` §4).
            (k) => k !== "goto" || legalTargets.length > 0,
          ).map((k) => ({ value: k, label: STEP_KIND_LABELS[k] }))}
        />
      )}

      {step.kind === "temp" && (
        <>
          <NumberLine
            label="Temperature"
            units="°C"
            value={step.tempC}
            onChange={(v) => onChange({ ...step, tempC: v ?? NaN })}
            error={err("tempC")}
          />
          <NumberLine
            label="Duration"
            units={step.holdSeconds === 0 ? "seconds (0 = hold forever)" : "seconds"}
            step="1"
            value={step.holdSeconds}
            onChange={(v) => onChange({ ...step, holdSeconds: v ?? NaN })}
            error={err("holdSeconds")}
          />
          <NumberLine
            label="Increment"
            units="°C per pass"
            optional
            value={step.incrementC}
            onChange={(v) => onChange({ ...step, incrementC: v })}
            error={err("incrementC")}
          />
          <NumberLine
            label="Ramp rate"
            units="°C/s"
            optional
            value={step.rateCPerSecond}
            onChange={(v) => onChange({ ...step, rateCPerSecond: v })}
            error={err("rateCPerSecond")}
          />
          <NumberLine
            label="Extend"
            units="seconds per pass"
            step="1"
            optional
            value={step.extendSeconds}
            onChange={(v) => onChange({ ...step, extendSeconds: v })}
            error={err("extendSeconds")}
          />
          <Line label="Beep">
            <input
              type="checkbox"
              className="stepform__check"
              checked={step.beep === true}
              onChange={(e) =>
                onChange(
                  (e.currentTarget as HTMLInputElement).checked
                    ? { ...step, beep: true }
                    : { ...step, beep: undefined },
                )
              }
            />
          </Line>
        </>
      )}

      {step.kind === "grad" && (
        <>
          <NumberLine
            label="Low temperature"
            units="°C"
            value={step.lowTempC}
            onChange={(v) => onChange({ ...step, lowTempC: v ?? NaN })}
            error={err("lowTempC")}
          />
          <NumberLine
            label="High temperature"
            units={`°C (${PROTOCOL_LIMITS.gradientSpreadC.min}–${PROTOCOL_LIMITS.gradientSpreadC.max} °C above the low)`}
            value={step.highTempC}
            onChange={(v) => onChange({ ...step, highTempC: v ?? NaN })}
            error={err("highTempC")}
          />
          <NumberLine
            label="Duration"
            units="seconds"
            step="1"
            value={step.holdSeconds}
            onChange={(v) => onChange({ ...step, holdSeconds: v ?? NaN })}
            error={err("holdSeconds")}
          />
          <NumberLine
            label="Extend"
            units="seconds per pass"
            step="1"
            optional
            value={step.extendSeconds}
            onChange={(v) => onChange({ ...step, extendSeconds: v })}
            error={err("extendSeconds")}
          />
        </>
      )}

      {step.kind === "melt" && (
        <>
          <NumberLine
            label="Start temperature"
            units="°C"
            value={step.startTempC}
            onChange={(v) => onChange({ ...step, startTempC: v ?? NaN })}
            error={err("startTempC")}
          />
          <NumberLine
            label="End temperature"
            units="°C"
            value={step.endTempC}
            onChange={(v) => onChange({ ...step, endTempC: v ?? NaN })}
            error={err("endTempC")}
          />
          <NumberLine
            label="Increment"
            units="°C per rung"
            value={step.incrementC}
            onChange={(v) => onChange({ ...step, incrementC: v ?? NaN })}
            error={err("incrementC")}
          />
          <NumberLine
            label="Hold"
            units="seconds per rung"
            step="1"
            value={step.holdSeconds}
            onChange={(v) => onChange({ ...step, holdSeconds: v ?? NaN })}
            error={err("holdSeconds")}
          />
          <ScanLines scan={step.scan} onChange={(scan) => onChange({ ...step, scan })} />
        </>
      )}

      {step.kind === "plateread" && (
        <ScanLines scan={step.scan} onChange={(scan) => onChange({ ...step, scan })} />
      )}

      {step.kind === "goto" && (
        <>
          <SelectLine
            label="Return to"
            value={String(step.targetStep)}
            onChange={(v) => onChange({ ...step, targetStep: Number(v) })}
            options={legalTargets.map((t) => ({
              value: String(t),
              label: `Step ${t}${targetLabels.get(t) ? ` — ${targetLabels.get(t)}` : ""}`,
            }))}
            error={err("targetStep")}
          />
          <NumberLine
            label="Repeats"
            units={
              Number.isFinite(step.repeats)
                ? `more passes (${step.repeats + 1} in total)`
                : "more passes"
            }
            step="1"
            value={step.repeats}
            onChange={(v) => onChange({ ...step, repeats: v ?? NaN })}
            error={err("repeats")}
          />
        </>
      )}
    </div>
  );
}
