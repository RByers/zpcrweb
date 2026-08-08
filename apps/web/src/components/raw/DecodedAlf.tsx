import { useMemo } from "react";
import { parseAlf, type AlfReport } from "@zpcrweb/core";
import { Pair } from "./Pair";

/**
 * The decoded `.alf` run report (`alf.md`) — who ran what, on which block, and whether anything
 * went wrong. The file's own text is a `*`-delimited wall of numbers, and the Raw view's Text mode
 * already shows it; what this adds is the header and error line pulled apart into named fields,
 * with the flags whose meaning is a sentence rather than a word.
 *
 * **What ran, and what it cost, is not here.** The report's protocol and its per-step execution log
 * were both rendered in this component once — a directive listing and a nine-column table of
 * timestamps. Both now live on the Protocol tab (`components/views/ProtocolView.tsx`): the protocol
 * as its annotated listing, and the step log as the thermal profile plotted against wall-clock time
 * (`ThermalProfileChart`, `alf.md` §7.6). The plot is the same derivation the table was — a step's
 * duration is the next step's start minus its own (§7.4), which is the only place a ramp cost is
 * measurable — but it shows a 46 s hold overrunning its nominal 30 at a glance, where the table
 * asked the reader to subtract. The literal fields are still one Text-mode click away.
 */
export function DecodedAlfFile({ text }: { text: string }) {
  const report = useMemo(() => parseAlf(text), [text]);
  return <DecodedAlf report={report} />;
}

export function DecodedAlf({ report }: { report: AlfReport }) {
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
          {/* The shape of the run, counted off the step log rather than off the protocol: what the
              instrument executed, loops and all. A stage boundary is not a field either — it is
              "the repeat count went backwards" (alf.md §7.2). */}
          <Pair
            k="Executed"
            v={
              `${report.steps.length} ${report.steps.length === 1 ? "step" : "steps"}` +
              (stages > 1 ? ` · ${stages} stages` : "") +
              (report.plateReadCount > 0
                ? ` · ${report.plateReadCount} plate read${report.plateReadCount === 1 ? "" : "s"}`
                : "")
            }
          />
          <Pair k="Finished" v={report.completionPhrase ?? "— (no sentinel line)"} />
        </dl>
        {/* alf.md §4: the header states no zone, so the times are the instrument's own clock. */}
        <p className="decoded__hint">
          The instrument's own record of the run, independent of <code>RunInfo.xml</code> — times
          are the instrument's local clock, with no time zone stated.
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
        {/* alf.md §6: every sample is clean, so only the shape of the flags is certain. */}
        <p className="decoded__hint">
          Worth checking before trusting the curves: a run that lost power or was aborted has
          later cycles that may not mean what they seem. Every sample the format was decoded from
          was clean, so the failure encodings have never been seen set — a flag is read as raised
          only for the literal <code>True</code>.
        </p>
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
