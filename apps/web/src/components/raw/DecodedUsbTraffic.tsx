import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { decodeUsbTrafficLog, hexDump, type UsbTrafficItem } from "@zpcrweb/core";

/** Rows drawn per page. A real session is ten thousand records and more (the status poll alone is
 * six a second and a half); drawing them all at once makes the view sluggish to open. */
const PAGE = 500;

/** Bytes of a field shown inline in the layout table before it defers to the payload dump. */
const INLINE_BYTES = 24;

const hex = (n: number, w = 8) => n.toString(16).padStart(w, "0");

function timeOfDay(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toISOString().slice(11, 23);
}

function dirMark(item: UsbTrafficItem): string {
  const r = item.record;
  if (!r || r.kind === "gap") return "";
  if (r.kind === "error") return "!!";
  return r.direction === "out" ? "→" : "←";
}

function rowClass(item: UsbTrafficItem): string {
  const r = item.record;
  const cls = ["usblog__row"];
  if (item.kind === "error" || item.kind === "invalid") cls.push("is-error");
  else if (item.kind !== "message") cls.push("is-meta");
  else if (r?.kind === "message") {
    if (r.poll) cls.push("is-poll");
    if (r.unsolicited) cls.push("is-unsolicited");
    if (r.direction === "in") cls.push("is-in");
  }
  return cls.join(" ");
}

/**
 * The Decoded view of a `usb-traffic.bin` — the USB traffic log the Instrument view records.
 *
 * The Text view prints one line per message; this one explains them. Every item of the file is a
 * row, the 8-byte header and segment markers included, so the rows account for every byte; opening
 * a row shows the item's bytes field by field (type, flag bits, time delta, channel, length,
 * payload), what the payload says — the request a reply answers, `STATUS?`'s fields named, upload
 * checksums and download sizes checked — and the whole payload as a hex dump. The reading itself
 * is core's `decodeUsbTrafficLog` (`usbTrafficDecode.ts`, format in `usb-traffic.md`); this
 * component only lays it out.
 *
 * Status polls are most of any log and can be hidden, but are shown by default: this is a raw
 * view, and what it shows first is everything the file holds.
 */
export function DecodedUsbTraffic({ bytes }: { bytes: Uint8Array }) {
  const decoded = useMemo(() => decodeUsbTrafficLog(bytes), [bytes]);
  const { items, totals } = decoded;

  const [hidePolls, setHidePolls] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [scrollTo, setScrollTo] = useState<number | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (hidePolls && it.record?.kind === "message" && it.record.poll) return false;
      return q === "" || it.meaning.summary.toLowerCase().includes(q);
    });
  }, [items, hidePolls, query]);

  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  /** Open another item (a request's reply, a reply's request) and bring it into view, lifting
   * whatever filter or page limit would keep it off screen. */
  const jump = (target: number) => {
    let pos = rows.findIndex((r) => r.index === target);
    if (pos < 0) {
      setHidePolls(false);
      setQuery("");
      pos = target; // with no filter, rows are items in order
    }
    if (pos >= limit) setLimit(Math.ceil((pos + 1) / PAGE) * PAGE);
    setOpen((s) => new Set(s).add(target));
    setScrollTo(target);
  };

  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollTo === null) return;
    tableRef.current
      ?.querySelector(`[data-item="${scrollTo}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    setScrollTo(null);
  }, [scrollTo, rows, limit]);

  const span =
    totals.first !== null && totals.last !== null
      ? `${new Date(totals.first).toISOString()} – ${new Date(totals.last).toISOString()}`
      : "—";

  return (
    <div className="usblog">
      <dl className="decoded__dl usblog__summary">
        <Pair k="Messages" v={totals.messages.toLocaleString()} />
        <Pair k="Status polls" v={totals.polls.toLocaleString()} />
        <Pair k="Transfer errors" v={totals.errors.toLocaleString()} />
        <Pair k="Segments" v={totals.segments.toLocaleString()} />
        <Pair k="Dropped" v={totals.dropped ? `${totals.dropped.toLocaleString()} records` : "none"} />
        <Pair k="Recorded (UTC)" v={span} wide />
      </dl>
      {decoded.error && <div className="usblog__error">{decoded.error}</div>}

      <div className="runlog__controls">
        <div className="runlog__group">
          <button
            className={"runlog__chip" + (!hidePolls ? " is-on" : "")}
            onClick={() => setHidePolls((h) => !h)}
            aria-pressed={!hidePolls}
            title="The STATUS?/RTSTATUS? requests and replies the app sends every 1.5 s"
          >
            Status polls
          </button>
          <input
            className="usblog__filter"
            type="search"
            placeholder="Filter, e.g. GETFILE"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
        <span className="runlog__count mono">
          {rows.length.toLocaleString()} / {items.length.toLocaleString()} items
        </span>
      </div>

      <div className="usblog__tblwrap" ref={tableRef}>
        <table className="runlog__tbl usblog__tbl mono">
          <thead>
            <tr>
              <th>#</th>
              <th>Offset</th>
              <th>Time (UTC)</th>
              <th></th>
              <th>Ch</th>
              <th className="usblog__num">Bytes</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((it) => {
              const isOpen = open.has(it.index);
              const r = it.record;
              return (
                <Fragment key={it.index}>
                  <tr
                    className={rowClass(it) + (isOpen ? " is-open" : "")}
                    data-item={it.index}
                    onClick={() => toggle(it.index)}
                  >
                    <td>
                      <button
                        className="usblog__toggle"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Hide" : "Show"} details of item ${it.index}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(it.index);
                        }}
                      >
                        {isOpen ? "▾" : "▸"}
                      </button>
                      {it.index}
                    </td>
                    <td className="usblog__off">{hex(it.offset)}</td>
                    <td title={it.at !== undefined ? new Date(it.at).toISOString() : ""}>{timeOfDay(it.at)}</td>
                    <td className="usblog__dir">{dirMark(it)}</td>
                    <td>{r?.kind === "message" ? r.channel : ""}</td>
                    <td className="usblog__num">{it.length.toLocaleString()}</td>
                    <td className="usblog__msg">{it.meaning.summary}</td>
                  </tr>
                  {isOpen && (
                    <tr className="usblog__detailrow">
                      <td colSpan={7}>
                        <ItemDetail item={it} bytes={bytes} onJump={jump} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {limit < rows.length && (
          <button className="raw__more" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({(rows.length - limit).toLocaleString()} items remaining)
          </button>
        )}
      </div>
    </div>
  );
}

function Pair({ k, v, wide }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={"decoded__pair" + (wide ? " usblog__wide" : "")}>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </div>
  );
}

/** One item opened: its bytes field by field, what they say, and the payload in full. */
function ItemDetail({
  item,
  bytes,
  onJump,
}: {
  item: UsbTrafficItem;
  bytes: Uint8Array;
  onJump: (index: number) => void;
}) {
  const m = item.meaning;
  const r = item.record;
  const payload = r?.kind === "message" ? r.payload : null;
  const payloadField = item.fields.find((f) => f.name === "Payload" || f.name === "Undecodable");
  const dump = useMemo(
    () =>
      payloadField ? hexDump(bytes.subarray(payloadField.offset, payloadField.offset + payloadField.length)) : "",
    [bytes, payloadField],
  );

  return (
    <div className="usblog__detail">
      {(m.replyTo !== undefined || (m.replies && m.replies.length > 0)) && (
        <div className="usblog__links">
          {m.replyTo !== undefined && (
            <button className="runlog__chip is-on" onClick={() => onJump(m.replyTo!)}>
              Answers item {m.replyTo}
            </button>
          )}
          {m.replies?.map((i) => (
            <button key={i} className="runlog__chip is-on" onClick={() => onJump(i)}>
              Reply: item {i}
            </button>
          ))}
        </div>
      )}
      {m.replies && m.replies.length === 0 && (
        <p className="decoded__hint">No reply to this request was recorded.</p>
      )}

      <section>
        <h3 className="decoded__h">Bytes in the file</h3>
        <table className="decoded__tbl usblog__fields">
          <thead>
            <tr>
              <th>Offset</th>
              <th>Bytes</th>
              <th>Field</th>
              <th>Value</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {item.fields.map((f) => {
              const shown = bytes.subarray(f.offset, f.offset + Math.min(f.length, INLINE_BYTES));
              const more =
                f.length > INLINE_BYTES
                  ? ` … (+${(f.length - INLINE_BYTES).toLocaleString()}${f === payloadField ? ", in full below" : ""})`
                  : "";
              return (
                <tr key={f.offset + f.name}>
                  <td className="usblog__off">
                    {hex(f.offset)}
                    {f.length > 1 && `–${hex(f.offset + f.length - 1)}`}
                  </td>
                  <td className="usblog__hex">
                    {Array.from(shown, (b) => hex(b, 2)).join(" ")}
                    {more}
                  </td>
                  <td className="decoded__fname">{f.name}</td>
                  <td>{f.value}</td>
                  <td className="usblog__note">{f.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {(m.fields.length > 0 || m.notes.length > 0) && (
        <section>
          <h3 className="decoded__h">{r?.kind === "message" ? (r.direction === "out" ? "The request" : "The reply") : "What it says"}</h3>
          {m.notes.map((n, i) => (
            <p key={i} className="decoded__hint">
              {n}
            </p>
          ))}
          {m.fields.length > 0 && (
            <table className="decoded__tbl usblog__fields">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>As sent</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {m.fields.map((f, i) => (
                  <tr key={i}>
                    <td className="decoded__fname">{f.label}</td>
                    <td className="usblog__raw">{f.raw ?? ""}</td>
                    <td className="usblog__note">{f.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {payloadField && (
        <section>
          <h3 className="decoded__h">
            {payload ? "Payload" : "Undecodable bytes"} — {payloadField.length.toLocaleString()} bytes from offset{" "}
            {hex(payloadField.offset)}
          </h3>
          <pre className="raw__dump usblog__dump mono">{dump || "(empty)"}</pre>
        </section>
      )}
    </div>
  );
}
