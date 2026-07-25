import type { Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { DownloadIcon } from "../DownloadIcon";
import { downloadBytes } from "../../lib/download";

interface Tile {
  label: string;
  value: string;
}

export function OverviewView({
  zpcr,
  file,
}: {
  zpcr: Zpcr;
  /** The active run's own name/bytes — downloaded verbatim, so this is also how a `.zpcr`
   * attached via the Plates view's upload control gets back onto disk (see `PlatesView`). */
  file: { name: string; bytes: Uint8Array };
}) {
  const m = zpcr.metadata;
  const reads = zpcr.reads;
  const protocolText = zpcr.protocolText || null;
  const protocol = zpcr.protocol();
  const protocolName = protocol?.name || null;
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
      <div className="overview__head">
        <section className="overview__tiles">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="tile__label">{t.label}</div>
              <div className="tile__value mono">{t.value}</div>
            </div>
          ))}
        </section>

        <div className="overview__toolbar">
          <button
            className="raw__download"
            onClick={() => downloadBytes(file.name, file.bytes)}
            aria-label={`Download ${file.name}`}
            title="Download original file"
          >
            <DownloadIcon />
          </button>
        </div>
      </div>

      {protocol?.steps ? (
        <section className="overview__block">
          <h2 className="overview__h">Thermal protocol</h2>
          <ProtocolStepsTable steps={protocol.steps} />
        </section>
      ) : (
        protocolText && (
          <section className="overview__block">
            <h2 className="overview__h">Thermal protocol</h2>
            <ProtocolDecoded text={protocolText} />
          </section>
        )
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
