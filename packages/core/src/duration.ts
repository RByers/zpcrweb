/**
 * How a length of time is written for a person to read.
 *
 * The instrument's own vocabulary is seconds — every hold, extension and elapsed time in a
 * `.prcl.txt` or an `.alf` is a plain integer count — but a number of seconds is a poor thing to
 * read: nobody sees `2700` and thinks *forty-five minutes* without doing the division first. So
 * anything shown to a user goes through {@link formatDuration}, which writes the clock time the
 * thermocycler's own front panel and every lab protocol on paper would use: `45:00`.
 *
 * One formatter, so the protocol listing, the thermal profile's tooltip and the `.alf` step table
 * cannot drift into three spellings of the same thirty seconds.
 */

/** Written for a negative duration — a true minus sign, not a hyphen. */
const MINUS = "−";

/**
 * `2700` → `45:00`, `90` → `1:30`, `5` → `0:05`.
 *
 * Hours appear as a third field (`1:05:00`) once the duration needs them, or whenever `hours` is
 * forced — which is what an axis wants, so its ticks all have the same shape and don't jump a
 * field partway along. Sub-minute times still get their leading `0:`: `0:05` reads as a time,
 * where a bare `5` would read as a count of something unstated.
 *
 * A non-finite input is `?` rather than `NaN:NaN` — a protocol with a malformed operand still
 * displays, the same way an unknown verb still gets a line (`protocol.md` §4).
 */
export function formatDuration(seconds: number, options?: { hours?: boolean }): string {
  if (!Number.isFinite(seconds)) return "?";
  const total = Math.abs(Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number): string => String(v).padStart(2, "0");
  const text = options?.hours || h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return seconds < 0 ? MINUS + text : text;
}
