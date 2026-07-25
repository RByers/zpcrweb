import type { Zpcr } from "@zpcrweb/core";

function safeText(zpcr: Zpcr, name: string): string | null {
  return zpcr.archive.entries.includes(name) ? zpcr.archive.text(name).trim() : null;
}

interface Tile {
  label: string;
  value: string;
}

export function OverviewView({ zpcr }: { zpcr: Zpcr }) {
  const m = zpcr.metadata;
  const reads = zpcr.reads;
  const protocol = zpcr.protocolText || null;
  const protocolName = safeText(zpcr, "ProtocolName.txt");
  const lastTemp = reads.at(-1)?.blockTempC;

  const tiles: Tile[] = [
    { label: "Block", value: m.blockDescription || "—" },
    { label: "Base serial", value: m.baseSerialNumber || "—" },
    { label: "Channels", value: `${m.channelCount} (mask ${m.scanMask})` },
    { label: "Cycles", value: String(reads.length) },
    { label: "Plate", value: `${m.numberPlateRows}×${m.numberPlateColumns} + ${m.numberReferenceRows} ref` },
    { label: "Protocol", value: protocolName || "—" },
    { label: "Run start", value: m.runStartDate ? m.runStartDate.toUTCString() : m.runStartTime || "—" },
    { label: "Last block temp", value: lastTemp != null ? `${lastTemp.toFixed(1)} °C` : "—" },
  ];

  return (
    <div className="overview">
      <section className="overview__tiles">
        {tiles.map((t) => (
          <div className="tile" key={t.label}>
            <div className="tile__label">{t.label}</div>
            <div className="tile__value mono">{t.value}</div>
          </div>
        ))}
      </section>

      {protocol && (
        <section className="overview__block">
          <h2 className="overview__h">Thermal protocol</h2>
          <pre className="overview__pre mono">{protocol}</pre>
        </section>
      )}

      <section className="overview__block">
        <h2 className="overview__h">Run identity</h2>
        <dl className="overview__dl mono">
          <dt>Identifier</dt>
          <dd>{m.identifier || "—"}</dd>
          <dt>Data file</dt>
          <dd>{m.dataFile || "—"}</dd>
          <dt>Archive entries</dt>
          <dd>{zpcr.archive.entries.length} files</dd>
        </dl>
      </section>
    </div>
  );
}
