interface Props {
  /** The last cycle the active step actually read — the highest real Cq stop. */
  cycleCount: number;
  /** Current bounds in cycles; `null` is unbounded on that side. See `FileSettings.cqMin`. */
  cqMin: number | null;
  cqMax: number | null;
  onChange: (patch: { cqMin: number | null; cqMax: number | null }) => void;
}

/** The extra stop past the last cycle: curves the run gave no Cq at all. */
const NONE_LABEL = "none";

/**
 * The Curves rail's Cq filter — a double-ended slider over the run's cycle range, with one stop
 * past the last cycle for the curves that never crossed their threshold.
 *
 * That extra stop is the whole reason this isn't two number fields. "No Cq" is not a number, but
 * it is where a non-amplifying curve belongs on a Cq axis — past every real one — so it reads as
 * the right-hand end of the same axis. Leaving the right handle there (the default) keeps those
 * curves on screen; pulling it down to a cycle drops them along with everything slower, and
 * pushing the *left* handle all the way up leaves only them, which is the "what didn't amplify?"
 * question the plate grid's `+` marks can't answer curve by curve.
 *
 * Two overlaid native `<input type="range">`s rather than a custom drag implementation: each
 * handle keeps real keyboard support and a real focus ring, and each `onChange` clamps against
 * the other so the handles can't cross. Only the thumbs take pointer events (see `.cq-range`
 * in `app.css`), so the lower handle stays grabbable where the two tracks overlap.
 */
export function CqRange({ cycleCount, cqMin, cqMax, onChange }: Props) {
  // Stops run 1..cycleCount for real Cq values, then one more for "no Cq". Bounds from a stored
  // record are clamped rather than trusted: the same file can be reopened on a step with fewer
  // cycles, which would otherwise leave a handle off the end of its own track.
  const none = cycleCount + 1;
  const clamp = (v: number) => Math.min(none, Math.max(1, Math.round(v)));
  const lo = cqMin == null ? 1 : clamp(cqMin);
  const hi = cqMax == null ? none : clamp(cqMax);
  const unfiltered = lo === 1 && hi === none;

  // Stored back as `null` at either end, so "unbounded" survives a change of step or cycle count
  // instead of being pinned to whatever the count happened to be when the handle was dropped.
  const commit = (nextLo: number, nextHi: number) =>
    onChange({
      cqMin: nextLo === 1 ? null : nextLo,
      cqMax: nextHi === none ? null : nextHi,
    });

  const label = (v: number) => (v === none ? NONE_LABEL : String(v));
  const pct = (v: number) => ((v - 1) / (none - 1)) * 100;

  return (
    <div className="cq-range">
      <div className="cq-range__head">
        <span>Cq range</span>
        {/* Both handles on the top stop is its own sentence, not a range: "none–none" reads like
            a broken value rather than "only the curves that never amplified". */}
        <span className="cq-range__value mono">
          {unfiltered
            ? "all"
            : lo === none
              ? "no Cq only"
              : `${label(lo)}–${label(hi)}`}
        </span>
      </div>
      {/* Coincident thumbs: whichever input is on top is the one the pointer can grab, so put the
          lower handle there — it's the one with somewhere to go. The exception is both handles
          parked at stop 1, where the lower one is already against its end stop and the upper is
          the only one that can move. */}
      <div className={"cq-range__slider" + (lo === hi && lo > 1 ? " is-lo-top" : "")}>
        <div className="cq-range__track" />
        <div
          className="cq-range__fill"
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          className="cq-range__input cq-range__input--lo"
          min={1}
          max={none}
          step={1}
          value={lo}
          aria-label="Lowest Cq shown"
          aria-valuetext={lo === none ? "no Cq only" : `cycle ${lo}`}
          onChange={(e) => {
            const v = Math.min(Number(e.currentTarget.value), hi);
            commit(v, hi);
          }}
        />
        <input
          type="range"
          className="cq-range__input cq-range__input--hi"
          min={1}
          max={none}
          step={1}
          value={hi}
          aria-label="Highest Cq shown; the last stop also includes curves with no Cq"
          aria-valuetext={hi === none ? "no Cq included" : `cycle ${hi}`}
          onChange={(e) => {
            const v = Math.max(Number(e.currentTarget.value), lo);
            commit(lo, v);
          }}
        />
      </div>
      <div className="cq-range__foot">
        <span className="cq-range__hint mono">
          {hi === none ? "incl. curves with no Cq" : "no-Cq curves hidden"}
        </span>
        <button
          type="button"
          className="rail__link"
          disabled={unfiltered}
          onClick={() => onChange({ cqMin: null, cqMax: null })}
        >
          all
        </button>
      </div>
    </div>
  );
}
