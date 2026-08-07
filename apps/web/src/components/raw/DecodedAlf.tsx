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
 * The decoded `.alf` run report (`alf.md`) — the instrument's own account of what the block did.
 *
 * The file's own text is a `*`-delimited wall of numbers, and the Raw view's Text mode already
 * shows it; what this adds is the three things reading it by eye can't give you:
 *
 * - **Wall-clock durations.** The report states no duration anywhere — a step's timestamp is
 *   when it *began* (`alf.md` §7.4), so how long it took is the next line's timestamp minus its
 *   own. Core computes that (`AlfStep.elapsedSeconds`); the "Took" column beside the nominal
 *   hold is where a ramp cost becomes visible.
 * - **Which step this was.** Field 3 is a bare step number; the protocol that numbers it is on
 *   line 2 of the same file, so the directive is joined back onto each row here.
 * - **Stage and read index.** Neither is a field: a stage boundary is "the repeat count went
 *   backwards" (§7.2), and a read's position among the archive's `.Plateread` files is its
 *   position among the `Plate Read` lines (§7.5).
 *
 * The fourth step column is deliberately absent. CFX Manager calls it `RAMPTIME`, it does not
 * behave like one, and nothing is known about when it captures (`alf.md` §8) — a column of
 * numbers with no meaning would invite exactly the reading the doc's measurements rule out. It
 * is still one Text-mode click away, which is the right place for a field nobody can interpret.
 */
export function DecodedAlfFile({ text }: { text: string }) {
  const report = useMemo(() => parseAlf(text), [text]);
  return <DecodedAlf report={report} />;
}

/** `hh:mm:ss` / `m:ss` for a count of seconds. */
function duration(seconds: number | null | undefined): string {
  return seconds == null ? "—" : formatDuration(seconds);
}

/** The clock part of a step's `MM/DD/YYYY HH:MM:SS`, which is all that changes down the log. */
function clock(step: AlfStep): string {
  const m = /\d{2}:\d{2}:\d{2}$/.exec(step.timestampText);
  return m ? m[0] : step.timestampText || "—";
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
        <h3 className="decoded__h">Run</h3>
        <dl className="decoded__dl mono">
          <Pair k="Name" v={h.runName || "—"} />
          <Pair k="User" v={h.user || "— (started at the instrument)"} />
          <Pair k="Block" v={`${h.blockSerial}${h.blockLetter ? ` ${h.blockLetter}` : ""} · ${h.blockType}`} />
          <Pair k="Base unit" v={h.baseSerial + (h.cyclerName && h.cyclerName !== h.baseSerial ? ` (${h.cyclerName})` : "")} />
          <Pair k="Began" v={`${h.dateBegan} ${h.timeBegan}`} />
          <Pair k="Ended" v={h.timeEnd} />
          <Pair k="Elapsed" v={h.totalElapsed || "—"} />
          <Pair k="Lid" v={h.lidTemperatureC != null ? `${h.lidTemperatureC} °C` : "—"} />
          <Pair k="Volume" v={h.sampleVolumeUl != null ? `${h.sampleVolumeUl} µL` : "—"} />
          <Pair k="Finished" v={report.completionPhrase ?? "— (no sentinel line)"} />
        </dl>
        <p className="decoded__hint">
          The instrument's own record of the run, independent of <code>RunInfo.xml</code> — times
          are the instrument's local clock, with no zone stated (alf.md §4).
        </p>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">Errors</h3>
        <p className={"decoded__hint" + (e.clean ? "" : " decoded__alarm")}>
          {e.text.trim() || "—"}
          {e.rawErrors.trim() && e.rawErrors.trim() !== "0:" ? ` · codes ${e.rawErrors}` : ""}
        </p>
        <dl className="decoded__dl mono">
          <Flag k="Power failed" on={e.powerFailed} />
          <Flag k="User aborted" on={e.userAborted} />
          <Flag k="Error" on={e.errorOccurred} />
          <Flag k="Critical" on={e.criticalError} />
          <Pair k="Emulation" v={e.emulationUsed ? e.emulationMode || "yes" : "no"} />
        </dl>
        <p className="decoded__hint">
          Worth checking before trusting the curves: a run that lost power or was aborted has
          later cycles that may not mean what they seem. Every sample the format was decoded from
          was clean, so the failure encodings are unverified (alf.md §6) — a flag is read as set
          only for the literal <code>True</code>.
        </p>
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">Protocol as executed</h3>
        <p className="decoded__hint">
          What actually ran, with the real scan mask — the archive's <code>.prcl</code> holds what
          was <em>authored</em> instead (alf.md §5, protocol.md §8).
        </p>
        <ProtocolDecoded text={report.runDefinition} />
      </section>

      <section className="decoded__block">
        <h3 className="decoded__h">
          Execution log — {report.steps.length} steps, {report.plateReadCount} plate reads
          {stages > 1 ? `, ${stages} stages` : ""}
        </h3>
        <p className="decoded__hint">
          One line per step <em>execution</em>. A timestamp is when the step began, so "took" is
          the next step's start minus this one's — the only place a ramp cost is measurable (alf.md
          §7.4). <code>GOTO</code> is never logged, which is why the step numbers jump (§7.1).
        </p>
        <div className="decoded__gridwrap">
          <table className="decoded__tbl decoded__alf mono">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Rep</th>
                <th>Step</th>
                <th>Directive</th>
                <th>Setpoint</th>
                <th>Hold</th>
                <th>Began</th>
                <th>Took</th>
                <th>Read</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((s, i) => {
                const newStage = i > 0 && s.stage !== report.steps[i - 1]!.stage;
                return (
                  <tr key={s.index} className={newStage ? "decoded__alfstage" : ""}>
                    <td>{s.stage}</td>
                    <td>{s.repeat}</td>
                    <td>{s.stepNumber}</td>
                    <td className="decoded__fname">{directiveOf.get(s.stepNumber) ?? "—"}</td>
                    <td>{setpointText(s)}</td>
                    <td>{s.setpoint.kind === "plateRead" ? "—" : duration(s.holdSeconds)}</td>
                    <td>{clock(s)}</td>
                    <td>{duration(s.elapsedSeconds)}</td>
                    <td>{s.readIndex ?? ""}</td>
                  </tr>
                );
              })}
              {report.sentinel && (
                <tr className="decoded__alfend">
                  <td colSpan={6}>{report.completionPhrase ?? "End of run"}</td>
                  <td>{clock(report.sentinel)}</td>
                  <td colSpan={2} />
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
