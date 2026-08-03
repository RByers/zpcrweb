import { useEffect, useState } from "react";

/**
 * The Instrument view talks to the CFX over WebUSB, which only Chromium-based browsers
 * implement — Firefox and Safari have no plans to (see
 * https://webstatus.dev/features/webusb). Everything else in the app degrades gracefully
 * without it, so this is a one-time heads-up rather than a hard gate.
 *
 * User-Agent Client Hints (`navigator.userAgentData`) is itself Chromium-only, so its
 * absence already implies a non-Chromium browser — no separate feature check needed.
 */
const DISMISSED_KEY = "zpcr:browserWarningDismissedAt";
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function isChromiumBased(): boolean {
  const nav = navigator as unknown as {
    userAgentData?: { brands?: Array<{ brand: string }> };
  };
  const brands = nav.userAgentData?.brands;
  if (!brands) return false;
  return brands.some((b) => b.brand === "Chromium");
}

function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISSED_KEY));
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

export function BrowserWarningModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isChromiumBased() && !recentlyDismissed()) setVisible(true);
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      /* ignore storage failures (private mode, etc.) */
    }
    setVisible(false);
  };

  return (
    <div className="browserwarn" role="dialog" aria-modal="true">
      <div className="browserwarn__box">
        <p className="browserwarn__text">
          zpcrweb has been tested on Chromium-based browsers due to the dependency on{" "}
          <a href="https://webstatus.dev/features/webusb" target="_blank" rel="noreferrer">
            WebUSB
          </a>
          .
        </p>
        <button type="button" className="segmented__item" onClick={dismiss}>
          Continue anyway
        </button>
      </div>
    </div>
  );
}
