import { useMemo } from "react";
import {
  formatDuration,
  parseAlf,
  parseRunDefinition,
  type AlfReport,
  type AlfStep,
} from "@zpcrweb/core";
import { ProtocolDecoded } from "./DecodedView";
import { Pair } from "./Pair";

/**
 * The decoded `.alf` run report (`alf.md`).
 *
 * This is a **raw** view, so it holds itself to the raw view's rule: everything the file contains,
 * at the file's own level of detail, with nothing dropped for being awkward. The report's four
 * line roles (§2) each get a block — the run header, the protocol as executed, the error summary,
 * and the executed-step log, one row per line of it — and every field of every line appears,
 * including the ones nothing can be said about. The prettified readings live on the other tabs:
 * Overview answers "how did this run go", Protocol draws the profile these timestamps trace.
 *
 * Two fields have no meaning attached, deliberately. The fourth step column is labelled `RAMPTIME`
 * by CFX Manager, does not behave like one, and nothing is known about when it captures (§8); the
 * error line's code list has only ever been seen empty (§6). Both are shown verbatim under neutral
 * headings — a raw view's job is to show them, not to guess.
 *
 * What the decode adds over the file's own `*`-delimited text is naming and three derivations the
 * file states nowhere:
 *
 * - **Wall-clock durations.** A step's timestamp is when it *began* (§7.4), so how long it took is
 *   the next line's timestamp minus its own. Core computes it (`AlfStep.elapsedSeconds`); the
 *   "Took" column beside the nominal hold is where a ramp cost becomes visible.
 * - **Which step this was.** Field 3 is a bare step number; the protocol that numbers it is on
 *   line 2 of the same file, so the directive is joined back onto each row.
 * - **Stage and read index.** Neither is a field: a stage boundary is "the repeat count went
 *   backwards" (§7.2), and a read's position among the archive's `.Plateread` files is its
 *   position among the `Plate Read` lines (§7.5).
 */
export function DecodedAlfFile({ text }: { text: string }) {
  const report = useMemo(() => parseAlf(text), [text]);
  return <DecodedAlf report={report} />;
}

/** `hh:mm:ss` / `m:ss` for a count of seconds. */
function duration(seconds: number | null | undefined): string {
  return seconds == null ? "—" : formatDuration(seconds);
}

/** An empty field, shown as empty rather than silently skipped — it is a field the file has. */
function orEmpty(v: string): React.ReactNode {
  return v === "" ? <span className="decoded__empty">∅</span> : v;
}

function setpointText(step: AlfStep): string {
  switch (step.setpoint.kind) {
    case "temperature":
      return `${step.setpoint.tempC} °C`;
    case "gradient":
      return `${step.setpoint.lowC}–${step.setpoint.highC} °C`;
    case "plateRead":
      return "Plate read";
    default:
      return step.setpointText;
  }
}

export function DecodedAlf({ report }: { report: AlfReport }) {
  // The protocol on line 2 is what numbers field 3, so the directive for a step comes from the
  // same file rather than from the archive's other copy of the protocol (`alf.md` §5: when the
  // two disagree, this one is the instrument's word).
  const directiveOf = useMemo(() => {
    const byStep = new Map<number, string>();
    for (const d of parseRunDefinition(report.runDefinition).directives) {
      if (d.stepNumber !== undefined) byStep.set(d.stepNumber, d.text);
    }
    return byStep;
  }, [report.runDefinition]);

  const h = report.header;
  const e = report.errors;
  const stages = new Set(report.steps.map((s) => s.stage)).size;

  return (
    <div className="decoded">
      <section className="decoded__block">
        <h3 className="decoded__h">Run header</h3>
        {/* All 15 fields of line 1, in the file's own order (alf.md §4), including the two that are
            empty in every sample seen — an empty field is a fact about the file, so it is shown as
            empty rather than left out. */}
        <dl className="decoded__dl mono">
          {/* Field 1 is the run name for a PC-started run and the selected protocol's *path* for
              one started at the touchscreen, so both the field and its basename are shown. */}
          <Pair k="Protocol" v={orEmpty(h.protocolName)} />
          <Pair k="Run name" v={orEmpty(h.runName)} />
          <Pair k="User" v={h.user === "" ? "∅ (started at the instrument)" : h.user} />
          <Pair k="Block serial" v={orEmpty(h.blockSerial)} />
          <Pair k="Block letter" v={orEmpty(h.blockLetter)} />
          <Pair k="Block type" v={orEmpty(h.blockType)} />
          <Pair k="Date began" v={orEmpty(h.dateBegan)} />
          <Pair k="Time began" v={orEmpty(h.timeBegan)} />
          <Pair k="Time ended" v={orEmpty(h.timeEnd)} />
          <Pair k="Total elapsed" v={orEmpty(h.totalElapsed)} />
          <Pair k="Lid" v={h.lidTemperatureC != null ? `${h.lidTemperatureC} °C` : "∅"} />
          <Pair k="Volume" v={h.sampleVolumeUl != null ? `${h.sampleVolumeUl} µL` : "∅"} />
          <Pair k="Sample ID" v={orEmpty(h.sampleId)} />
          <Pair k="Cycler name" v={orEmpty(h.cyclerName)} />
          <Pair k="Base serial" v={orEmpty(h.baseSerial)} />
          <Pair k="Lid pressure" v={orEmpty(h.lidPressure)} />
        </dl>
        {/* alf.md §4: the header states no zone, so the times are the instrument's own clock. */}
        <p className="decoded__hint">
          The instrument's own record of the run, independent of <code>RunInfo.xml</code> — times
          are the instrument's local clock, with no time zone stated.
        </p>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">Protocol as executed</h3>
        {/* alf.md §5 and protocol.md §8: the report's copy is post-expansion, with the scan mask
            the run really used, so it can differ from the archive's authored `.prcl`. */}
        <p className="decoded__hint">
          Line 2 of the file: what actually ran, with the real scan mask — an archive's{" "}
          <code>.prcl</code> holds what was <em>authored</em> instead.
        </p>
        <ProtocolDecoded text={report.runDefinition} />
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">Errors</h3>
        <p className={"decoded__hint" + (e.clean ? "" : " decoded__alarm")}>
          {e.text.trim() || "—"}
        </p>
        {/* All 8 fields of line 3 (alf.md §6). The code list is shown whatever it says: only the
            empty `0:` has ever been observed, so its grammar is unknown and it stays text. */}
        <dl className="decoded__dl mono">
          <Pair k="Codes" v={orEmpty(e.rawErrors)} />
          <Flag k="Power failed" on={e.powerFailed} />
          <Flag k="User aborted" on={e.userAborted} />
          <Flag k="Error" on={e.errorOccurred} />
          <Flag k="Emulation used" on={e.emulationUsed} />
          <Pair k="Emulation mode" v={orEmpty(e.emulationMode)} />
          <Flag k="Critical" on={e.criticalError} />
        </dl>
        {/* Why these flags matter, and how far to trust them (`alf.md` §6): a run that lost power
            or was aborted has later cycles that may not mean what they seem. But every sample the
            format was decoded from was clean, so the failure encodings have never been seen set —
            core reads a flag as raised only for the literal `True`. That is provenance for whoever
            maintains this, not something to tell the reader in the app. */}
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">
          Execution log — {report.steps.length} {report.steps.length === 1 ? "step" : "steps"}
          {report.plateReadCount > 0
            ? `, ${report.plateReadCount} plate read${report.plateReadCount === 1 ? "" : "s"}`
            : ""}
          {stages > 1 ? `, ${stages} stages` : ""}
        </h3>
        {/* alf.md §7.4 for the timestamp meaning, §7.1 for GOTO never being logged, §8 for the
            column headed "Field 4" — labelled a ramp time, doesn't behave like one, so it is
            carried through under a heading that claims nothing. */}
        <p className="decoded__hint">
          One line per step <em>execution</em>, with all nine of its fields. A timestamp is when the
          step began, so "took" is the next step's start minus this one's — the only place a ramp
          cost is measurable. <code>GOTO</code> is never logged, which is why the step numbers jump.
          Field 4 is shown as written: it is labelled a ramp time and does not measure one.
        </p>
        <div className="decoded__gridwrap">
          <table className="decoded__tbl decoded__alf mono">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Cycle</th>
                <th>Rep</th>
                <th>Step</th>
                <th>Field 4</th>
                <th>Directive</th>
                <th>Setpoint</th>
                <th>Hold</th>
                <th>Began</th>
                <th>Took</th>
                <th>Paused</th>
                <th>Read</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s, i) => {
                const newStage = i > 0 && s.stage !== report.steps[i - 1]!.stage;
                return (
                  <tr key={s.index} className={newStage ? "decoded__alfstage" : ""}>
                    <td>{s.stage}</td>
                    <td>{s.cycleField}</td>
                    <td>{s.repeat}</td>
                    <td>{s.stepNumber}</td>
                    <td>{s.rampTimeField ?? "—"}</td>
                    <td className="decoded__fname">{directiveOf.get(s.stepNumber) ?? "—"}</td>
                    <td>{setpointText(s)}</td>
                    <td>{s.setpoint.kind === "plateRead" ? "—" : duration(s.holdSeconds)}</td>
                    <td>{s.timestampText || "—"}</td>
                    <td>{duration(s.elapsedSeconds)}</td>
                    {/* Fields 8 and 9 are a pair — `False`/`0` in every line of every sample, and
                        meaningless apart, so one column carries both. */}
                    <td>{s.paused ? `yes · ${duration(s.pausedSeconds)}` : "no"}</td>
                    <td>{s.readIndex ?? ""}</td>
                  </tr>
                );
              })}
              {report.sentinel && (
                <tr className="decoded__alfend">
                  <td colSpan={8}>{report.completionPhrase ?? "End of run"}</td>
                  <td>{report.sentinel.timestampText || "—"}</td>
                  <td colSpan={3} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {report.problems.length > 0 && (
        <section className="decoded__block">
          <h3 className="decoded__h">Problems</h3>
          <ul className="decoded__hint decoded__alarm">
            {report.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** An error-summary flag: quiet when clear, alarmed when set — the whole point of the line. */
function Flag({ k, on }: { k: string; on: boolean }) {
  return (
    <div className="decoded__pair">
      <dt>{k}</dt>
      <dd className={on ? "decoded__alarm" : "decoded__empty"}>{on ? "YES" : "no"}</dd>
    </div>
  );
}
