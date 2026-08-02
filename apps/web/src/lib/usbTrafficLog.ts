import type { ConsoleLine } from "../state/useCfxDevice";

/** The name the USB traffic log is stored under, both in a downloaded `.log` file and as an
 * extra entry in a run's `.zpcr` — kept in one place so the two never drift apart. */
export const USB_TRAFFIC_LOG_NAME = "usb-traffic.log";

/**
 * Render every captured USB message and transfer error as one line each, in wire order.
 *
 * A message line always carries `[<n>B] <hex>` — the exact payload bytes — even when it's also
 * shown decoded as `text=...`: the decode is a best-effort guess (`asText` in `device.ts`, latin1,
 * "every byte printable or not") and the app additionally trims a trailing `\r`/`\n` from it, so
 * for a payload this is meant to help *decode*, the raw bytes are the ground truth and the text is
 * a convenience alongside them, never a replacement for them.
 *
 * Shared by the console's download button and the copy embedded in a run's `.zpcr`, so both read
 * exactly the same format.
 */
export function formatTrafficLog(lines: readonly ConsoleLine[]): string {
  const rows = lines.map((l) => {
    const at = new Date(l.at).toISOString();
    if (l.kind === "error") {
      const status = l.fatal ? "fatal" : "retrying";
      return `${at} !! transfer error (${l.direction}, attempt ${l.attempt}, ${status}): ${l.message}`;
    }
    const dir = l.direction === "out" ? "->" : "<-";
    const flag = l.unsolicited ? " (unsolicited)" : "";
    const text = l.text !== null ? ` text=${JSON.stringify(l.text)}` : "";
    return `${at} ${dir} ch${l.channel}${flag} [${l.bytes}B] ${l.hex}${text}`;
  });
  return rows.length === 0 ? "" : rows.join("\n") + "\n";
}
