/** Leading setup directives that are not numbered protocol steps. */
const PROTOCOL_SETUP = /^(METHOD|HOTLID|VOLUME)\b/i;

/**
 * Render a `;`-separated `ProtocolRunDefinition`/`runDefinition` program (prcl.md §3). Thermal
 * steps are numbered 1-based (skipping the METHOD/HOTLID/VOLUME setup directives) so `GOTO N,M`
 * points exactly at step N — e.g. `GOTO 2,44` → step 2. Shared by the archive's
 * `ProtocolRunDefinition.txt` viewer and the `.prcl`/`protocol2` plaintext-variant fallback.
 */
export function ProtocolTextLines({ text }: { text: string }) {
  const lines = text
    .trim()
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let stepNo = 0;
  return (
    <div className="decoded__proto mono">
      {lines.map((line, i) => {
        const setup = PROTOCOL_SETUP.test(line);
        const num = setup ? "" : String((stepNo += 1));
        return (
          <div key={i} className={"decoded__protoline" + (setup ? " is-setup" : "")}>
            <span className="decoded__protonum">{num}</span>
            <span>{line};</span>
          </div>
        );
      })}
    </div>
  );
}
