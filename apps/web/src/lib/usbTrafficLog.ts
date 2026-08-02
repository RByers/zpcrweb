import type { TrafficLine } from "../state/useCfxDevice";

/** The name the USB traffic log is stored under, both in a downloaded `.log` file and as an
 * extra entry in a run's `.zpcr` — kept in one place so the two never drift apart. */
export const USB_TRAFFIC_LOG_NAME = "usb-traffic.log";

/**
 * Render every captured USB message as one line: timestamp, direction, channel, and the payload
 * as text or hex. Shared by the console's download button and the copy embedded in a run's
 * `.zpcr`, so both read exactly the same format.
 */
export function formatTrafficLog(lines: readonly TrafficLine[]): string {
  const rows = lines.map((l) => {
    const at = new Date(l.at).toISOString();
    const dir = l.direction === "out" ? "->" : "<-";
    const flag = l.unsolicited ? " (unsolicited)" : "";
    const body = l.text !== null ? l.text : `[${l.bytes}B] ${l.hex}`;
    return `${at} ${dir} ch${l.channel}${flag} ${body}`;
  });
  return rows.length === 0 ? "" : rows.join("\n") + "\n";
}
