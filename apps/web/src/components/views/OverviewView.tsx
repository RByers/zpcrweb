import { useMemo } from "react";
import type { Zpcr } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { DownloadIcon } from "../DownloadIcon";
import { downloadBytes } from "../../lib/download";
import { usePltdPassword } from "../../state/pltdPassword";
import { plateTargets } from "../../lib/plateTargets";
import { channelColor } from "../../lib/channelColors";
import { runEncryptionStatus } from "../../lib/encryptionStatus";
import type { RunResult } from "../../state/useZpcrStore";

interface Tile {
  label: string;
  value: string;
}

export function OverviewView({
  zpcr,
  file,
  run,
}: {
  zpcr: Zpcr;
  /** The active run's own name/bytes — downloaded verbatim, so this is also how a `.zpcr`
   * attached via the Plates view's upload control gets back onto disk (see `PlatesView`). */
  file: { name: string; bytes: Uint8Array };
  /** The same run result the app resolved `zpcr` from — carries `.pcrd` container metadata
   * (`encrypted`) that `zpcr` alone doesn't expose; see {@link runEncryptionStatus}. */
  run: RunResult;
}) {
  const m = zpcr.metadata;
  const reads = zpcr.reads;
  const protocolText = zpcr.protocolText || null;
  const protocol = zpcr.protocol();
  const protocolName = protocol?.name || null;
  const lastTemp = reads.at(-1)?.blockTempC;

  const [password] = usePltdPassword();
  const plate = useMemo(() => zpcr.plates(password || undefined)[0]?.pltd.plate ?? null, [zpcr, password]);
  const encStatus = useMemo(() => runEncryptionStatus(run, password), [run, password]);
  const targets = useMemo(() => (plate ? plateTargets(plate) : []), [plate]);
  const samples = plate?.samples ?? [];

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

      {plate && (targets.length > 0 || samples.length > 0) && (
        <section className="overview__block">
          <h2 className="overview__h">Plate</h2>
          <div className="overview__platelists">
            {targets.length > 0 && (
              <div className="overview__platelist">
                <div className="overview__platelist-h">Targets</div>
                <div className="filecard__chips">
                  {targets.map((t) => (
                    <span
                      key={t.name}
                      className="filecard__chip"
                      style={t.channel != null ? { color: channelColor(t.channel) } : undefined}
                    >
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {samples.length > 0 && (
              <div className="overview__platelist">
                <div className="overview__platelist-h">Samples</div>
                <div className="filecard__chips">
                  {samples.map((s) => (
                    <span key={s} className="filecard__chip">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="overview__block">
        <h2 className="overview__h">Encrypted</h2>
        {encStatus.kind === "none" && <div className="overview__enc overview__enc--none">No</div>}
        {encStatus.kind === "decrypted" && (
          <div className="overview__enc overview__enc--decrypted">
            Yes
            <div className="overview__enc-password mono">password: {encStatus.password}</div>
          </div>
        )}
        {encStatus.kind === "locked" && <div className="overview__enc overview__enc--locked">Yes</div>}
      </section>

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
