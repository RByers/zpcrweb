import { useMemo, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";
import { parseXmlFragment, XmlTree } from "../../lib/xmlTree";
import { logEntriesFromElements, summarizeRunLog } from "../../lib/runlog";
import { DecodedPlateread } from "../raw/DecodedPlateread";
import { PlateDetail } from "../raw/DecodedPlate";
import { RunInfoTable, ProtocolDecoded } from "../raw/DecodedView";
import { RunLogTable } from "../raw/RunLogTable";

/**
 * The `.pcrd` counterpart to `RawFilesView` — but a `.pcrd` has no inner files, so this
 * browses the document's real XML structure instead of a file list: a "Document" entry shows
 * the whole tree (large subtrees collapsed by default — see `lib/xmlTree.tsx`), and other nav
 * entries correspond to `<experimentalData2>`'s actual children (see `pcrd.md`), each showing
 * either a typed decoded view (reusing the same components `RawFilesView` uses for a `.zpcr`'s
 * real files) or the raw XML subtree.
 */

type NavEntry =
  | { kind: "document" }
  | { kind: "plateSetup" }
  | { kind: "protocol" }
  | { kind: "plateRead"; index: number }
  | { kind: "calibration" }
  | { kind: "runInfo" }
  | { kind: "log" }
  | { kind: "other"; el: Element };

interface NavItem {
  label: string;
  entry: NavEntry;
}

interface NavGroup {
  group: string;
  items: NavItem[];
}

function findChild(el: Element | undefined, tagLower: string): Element | undefined {
  return el && Array.from(el.children).find((c) => c.tagName.toLowerCase() === tagLower);
}

interface PcrdDocument {
  root: Element;
  groups: NavGroup[];
  plateSetup2El?: Element;
  protocol2El?: Element;
  calibrationEl?: Element;
  runInfoEl?: Element;
  logEls: Element[];
  plateReadEls: Element[];
}

function buildDocument(root: Element, zpcr: Zpcr): PcrdDocument {
  const children = Array.from(root.children);
  const byTag = (tagLower: string): Element | undefined =>
    children.find((c) => c.tagName.toLowerCase() === tagLower);

  const plateSetup2El = byTag("platesetup2");
  const protocol2El = byTag("protocol2");
  const runDataEl = byTag("rundata");
  const protocolRunInfoEl = byTag("protocolruninfo");
  const calibrationEl = findChild(runDataEl, "calibrationcollection");
  const plateReadVectorEl = findChild(runDataEl, "platereaddatavector");
  const runInfoEl = findChild(protocolRunInfoEl, "runinfo");
  const logEls = children.filter((c) => c.tagName.toLowerCase() === "log");
  const plateReadEls = plateReadVectorEl ? Array.from(plateReadVectorEl.children) : [];

  const known = new Set(
    [plateSetup2El, protocol2El, runDataEl, protocolRunInfoEl, ...logEls].filter(
      (e): e is Element => e !== undefined,
    ),
  );
  const otherEls = children.filter((c) => !known.has(c));

  const groups: NavGroup[] = [
    { group: "Document", items: [{ label: "Document", entry: { kind: "document" } }] },
  ];
  if (plateSetup2El) {
    groups.push({
      group: "Plate setup",
      items: [{ label: "plateSetup2", entry: { kind: "plateSetup" } }],
    });
  }
  if (protocol2El) {
    groups.push({
      group: "Protocol",
      items: [{ label: "protocol2", entry: { kind: "protocol" } }],
    });
  }
  if (plateReadEls.length > 0) {
    groups.push({
      group: "Plate reads",
      items: zpcr.reads.map((r, i) => ({
        label: `Cycle ${r.cycle}`,
        entry: { kind: "plateRead", index: i },
      })),
    });
  }
  if (calibrationEl) {
    groups.push({
      group: "Calibration",
      items: [{ label: "calibrationCollection", entry: { kind: "calibration" } }],
    });
  }
  if (runInfoEl) {
    groups.push({ group: "Run info", items: [{ label: "RunInfo", entry: { kind: "runInfo" } }] });
  }
  if (logEls.length > 0) {
    groups.push({
      group: "Log",
      items: [{ label: `log (${logEls.length})`, entry: { kind: "log" } }],
    });
  }
  if (otherEls.length > 0) {
    groups.push({
      group: "Other",
      items: otherEls.map((el) => ({ label: el.tagName, entry: { kind: "other", el } })),
    });
  }

  return { root, groups, plateSetup2El, protocol2El, calibrationEl, runInfoEl, logEls, plateReadEls };
}

function entryKey(entry: NavEntry): string {
  if (entry.kind === "plateRead") return `plateRead:${entry.index}`;
  if (entry.kind === "other") return `other:${entry.el.tagName}`;
  return entry.kind;
}

export function PcrdRawView({ zpcr, documentXml }: { zpcr: Zpcr; documentXml: string }) {
  const doc = useMemo(() => {
    const root = parseXmlFragment(documentXml);
    return root ? buildDocument(root, zpcr) : null;
  }, [documentXml, zpcr]);

  const [selected, setSelected] = useState<NavEntry>({ kind: "document" });
  const [mode, setMode] = useState<"decoded" | "xml">("xml");

  if (!doc) return <div className="decoded__na mono">Could not parse the .pcrd document.</div>;

  const select = (entry: NavEntry, hasDecoded: boolean) => {
    setSelected(entry);
    setMode(hasDecoded ? "decoded" : "xml");
  };

  const hasDecoded = (entry: NavEntry): boolean =>
    entry.kind === "plateSetup" ||
    entry.kind === "protocol" ||
    entry.kind === "plateRead" ||
    entry.kind === "runInfo" ||
    entry.kind === "log";

  return (
    <div className="raw">
      <aside className="raw__list">
        {doc.groups.map((g) => (
          <div className="raw__group" key={g.group}>
            <div className="raw__grouphead">{g.group}</div>
            {g.items.map((item) => (
              <button
                key={entryKey(item.entry)}
                className={
                  "raw__item mono" + (entryKey(item.entry) === entryKey(selected) ? " is-active" : "")
                }
                onClick={() => select(item.entry, hasDecoded(item.entry))}
                title={item.label}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <section className="raw__viewer">
        <div className="raw__toolbar">
          <span className="raw__fname mono">{entryLabel(selected, doc)}</span>
          <div className="segmented segmented--sm raw__modes">
            <button
              className={"segmented__item" + (mode === "decoded" ? " is-active" : "")}
              onClick={() => setMode("decoded")}
              disabled={!hasDecoded(selected)}
              title={hasDecoded(selected) ? "" : "No decoder for this node"}
            >
              Decoded
            </button>
            <button
              className={"segmented__item" + (mode === "xml" ? " is-active" : "")}
              onClick={() => setMode("xml")}
            >
              XML
            </button>
          </div>
        </div>

        <div className="raw__decoded">
          <PcrdRawContent zpcr={zpcr} doc={doc} entry={selected} mode={mode} />
        </div>
      </section>
    </div>
  );
}

function entryLabel(entry: NavEntry, doc: PcrdDocument): string {
  switch (entry.kind) {
    case "document":
      return "Document";
    case "plateSetup":
      return "plateSetup2";
    case "protocol":
      return "protocol2";
    case "plateRead":
      return doc.plateReadEls[entry.index]?.tagName ?? "plateRead";
    case "calibration":
      return "calibrationCollection";
    case "runInfo":
      return "RunInfo";
    case "log":
      return `log × ${doc.logEls.length}`;
    case "other":
      return entry.el.tagName;
  }
}

function PcrdRawContent({
  zpcr,
  doc,
  entry,
  mode,
}: {
  zpcr: Zpcr;
  doc: PcrdDocument;
  entry: NavEntry;
  mode: "decoded" | "xml";
}) {
  if (entry.kind === "document") return <XmlTree roots={[doc.root]} />;

  if (entry.kind === "plateSetup") {
    if (mode === "xml") return <XmlTree roots={doc.plateSetup2El ? [doc.plateSetup2El] : []} />;
    const plate = zpcr.plates()[0]?.pltd.plate;
    if (!plate) return <div className="decoded__na mono">No plate decoded.</div>;
    return <PlateDetail plate={plate} sourceHint="embedded in .pcrd document" />;
  }

  if (entry.kind === "protocol") {
    if (mode === "xml") return <XmlTree roots={doc.protocol2El ? [doc.protocol2El] : []} />;
    return <ProtocolDecoded text={zpcr.protocolText} />;
  }

  if (entry.kind === "plateRead") {
    const el = doc.plateReadEls[entry.index];
    if (mode === "xml") return <XmlTree roots={el ? [el] : []} />;
    const read = zpcr.reads[entry.index];
    if (!read) return <div className="decoded__na mono">No decoded read.</div>;
    return <DecodedPlateread zpcr={zpcr} read={read} />;
  }

  if (entry.kind === "calibration") {
    return <XmlTree roots={doc.calibrationEl ? [doc.calibrationEl] : []} />;
  }

  if (entry.kind === "runInfo") {
    if (mode === "xml") return <XmlTree roots={doc.runInfoEl ? [doc.runInfoEl] : []} />;
    const text = doc.runInfoEl ? new XMLSerializer().serializeToString(doc.runInfoEl) : "";
    return <RunInfoTable text={text} />;
  }

  if (entry.kind === "log") {
    if (mode === "xml") return <XmlTree roots={doc.logEls} />;
    return <RunLogTable parsed={summarizeRunLog(logEntriesFromElements(doc.logEls))} />;
  }

  // "other"
  return <XmlTree roots={[entry.el]} />;
}
