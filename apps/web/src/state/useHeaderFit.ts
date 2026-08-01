import { useLayoutEffect, useRef, useState } from "react";

/**
 * How hard the header is currently squeezed. Each level drops one more piece of text, leaving
 * the icon (and the `title`/`aria-label` that names it) behind:
 *
 * - 0 — everything: `zpcr//web`, seven labelled tabs, "load file".
 * - 1 — the wordmark's tail and the load button's word go: `zpcr` + icon.
 * - 2 — every tab label but the selected one's, so the current view still reads as a word.
 * - 3 — all icons.
 *
 * The old rule was a `max-width: 599px` media query, which is wrong: at level 2 the header's
 * natural width depends on which label is the surviving one ("Calibration" is nearly three times
 * "Raw files"), so a single breakpoint necessarily either collapses a header that still fits or
 * lets one overflow. Measuring instead means the header collapses at the exact width it stops
 * fitting, whatever it currently holds.
 */
const MAX_FIT = 3;

/** Every header element whose text collapses. Kept in sync with the rules in `app.css`. */
const COLLAPSIBLE = ".app__logo-rest, .segmented__label, .dropzone__compact-label";

/** A header child's natural width — `.app__views` is a scroller, so its rect is the *clipped*
 * width once the tab strip overflows; `scrollWidth` is the strip itself. For the unclipped
 * children (logo, load button) the rect is the larger of the two, since it includes borders. */
function childWidth(el: HTMLElement) {
  return Math.max(el.getBoundingClientRect().width, el.scrollWidth);
}

/** What a header's children want, laid out as they currently are. The spacer contributes no
 * width of its own (it's `flex: 1` from a zero basis) but still sits between two gaps. */
function contentWidth(header: HTMLElement) {
  const gap = parseFloat(getComputedStyle(header).columnGap) || 0;
  const kids = Array.from(header.children) as HTMLElement[];
  let total = gap * Math.max(0, kids.length - 1);
  for (const kid of kids) {
    if (!kid.classList.contains("app__header-spacer")) total += childWidth(kid);
  }
  return total;
}

/**
 * Picks the header's `data-fit` level by measurement: it walks the levels from roomiest to
 * tightest and takes the first one that actually fits the header's content box.
 *
 * Rather than model each label's width arithmetically, it *simulates* — writing `data-fit` onto
 * a header and reading the resulting layout back. That costs a handful of synchronous layouts of
 * one small flex row per resize, and in exchange every collapsed-state quirk (the icon/label
 * gap, the tab's padding, the scroller) is accounted for exactly, because the browser is the one
 * accounting for it.
 *
 * The simulation runs on a hidden **clone**, not on the live header, and that indirection is
 * load-bearing rather than defensive. Probing in place means forcing a style recalc with
 * transitions suppressed (otherwise a half-finished animation gets measured) at the very moment
 * React has just committed the new state — so the browser computes the *destination* widths with
 * no transition, the label snaps, and nothing ever animates. Measuring a copy leaves the real
 * header's style untouched until `fit` is committed, which is what makes the transitions in
 * `app.css` run at all.
 *
 * Level 0 is also where every label is expanded, so it's where each one's natural width is read
 * off the clone and written to the real label's `--w`, which is what the CSS animates back out
 * to (`max-width` can't transition to `auto`).
 *
 * @param deps re-measure when these change — in practice the selected view, which is what decides
 *   the one label level 2 keeps. The tab strip itself is the same tabs for every file (`App.tsx`
 *   disables the ones a file has no answer for rather than dropping them), so a file switch
 *   doesn't change the header's width. Resizes are caught by a `ResizeObserver`.
 */
export function useHeaderFit(deps: unknown[]) {
  const ref = useRef<HTMLElement>(null);
  const [fit, setFit] = useState(0);
  // Outside the effect on purpose: a dep change re-runs the effect, and a flag local to it would
  // re-arm the first-pass suppression below — which would silently kill the animation on exactly
  // the changes (a tab switch, a new file) that most want it.
  const firstPass = useRef(true);

  useLayoutEffect(() => {
    const header = ref.current;
    if (!header) return;
    let live = true;
    let raf = 0;

    const measure = () => {
      if (!live) return;
      const cs = getComputedStyle(header);
      const avail =
        header.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

      const clone = header.cloneNode(true) as HTMLElement;
      clone.dataset.measuring = "";
      clone.removeAttribute("id");
      clone.setAttribute("aria-hidden", "true");
      // Out of flow and invisible, but laid out — and pinned to the real header's width so the
      // flex line it has to fit into is the same one.
      clone.style.cssText = `position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;width:${header.getBoundingClientRect().width}px`;
      header.parentElement?.appendChild(clone);

      const real = Array.from(header.querySelectorAll<HTMLElement>(COLLAPSIBLE));
      const copies = Array.from(clone.querySelectorAll<HTMLElement>(COLLAPSIBLE));

      let chosen = MAX_FIT;
      try {
        for (let level = 0; level <= MAX_FIT; level++) {
          clone.dataset.fit = String(level);
          if (level === 0) {
            // Unclamp first: a label still capped at the width recorded before a font swap would
            // otherwise re-measure as its own stale value and never grow back.
            for (const el of copies) el.style.setProperty("--w", "none");
            copies.forEach((el, i) => {
              real[i]?.style.setProperty("--w", `${el.getBoundingClientRect().width}px`);
            });
          }
          // Half a pixel of slack: sub-pixel text metrics otherwise collapse a header that fits.
          if (contentWidth(clone) <= avail + 0.5) {
            chosen = level;
            break;
          }
        }
      } finally {
        clone.remove();
      }

      setFit(chosen);

      // The very first pass runs before the header has ever painted, so there's no previous
      // state worth animating out of — suppress the transition across that one commit.
      if (firstPass.current) {
        firstPass.current = false;
        header.dataset.measuring = "";
        requestAnimationFrame(() => {
          if (live) delete header.dataset.measuring;
        });
      }
    };

    measure();

    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(header);
    // Labels measured against a fallback font are the wrong width; redo it once the real one is in.
    void document.fonts?.ready.then(measure);

    return () => {
      live = false;
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, fit };
}
