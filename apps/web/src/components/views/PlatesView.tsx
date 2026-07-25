import { useMemo, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";
import { PlateViewer } from "../plate/PlateViewer";
import { PasswordPrompt } from "../PasswordPrompt";
import { usePltdPassword } from "../../state/pltdPassword";

/**
 * Visual plate viewer for every plate file attached to the run — one per `.pltd` archive
 * entry (a `.zpcr`) or the single embedded `plateSetup2` (a `.pcrd`); {@link Zpcr.plates}
 * covers both uniformly. A peer of "Curves", separate from "Raw files" (which shows plate
 * data as a table instead, see `raw/PlateTable.tsx`).
 */
export function PlatesView({ zpcr }: { zpcr: Zpcr }) {
  const [password, setPassword] = usePltdPassword();
  const entries = useMemo(() => zpcr.plates(password || undefined), [zpcr, password]);
  const [selected, setSelected] = useState(0);

  if (entries.length === 0) {
    return <div className="decoded__na mono">No plate files in this run.</div>;
  }

  const entry = entries[Math.min(selected, entries.length - 1)]!;
  const { pltd } = entry;

  return (
    <div className="raw">
      {entries.length > 1 && (
        <aside className="raw__list">
          <div className="raw__group">
            <div className="raw__grouphead">Plates</div>
            {entries.map((e, i) => (
              <button
                key={e.name}
                className={"raw__item mono" + (i === selected ? " is-active" : "")}
                onClick={() => setSelected(i)}
                title={e.name}
              >
                {e.name}
              </button>
            ))}
          </div>
        </aside>
      )}

      <section className="raw__viewer">
        {pltd.needsPassword || pltd.error ? (
          <div className="decoded">
            <PasswordPrompt wrong={!!pltd.error} onSubmit={setPassword} />
          </div>
        ) : !pltd.plate ? (
          <div className="decoded__na mono">No plate for {entry.name}.</div>
        ) : (
          <PlateViewer plate={pltd.plate} sourceHint={entry.name} />
        )}
      </section>
    </div>
  );
}
