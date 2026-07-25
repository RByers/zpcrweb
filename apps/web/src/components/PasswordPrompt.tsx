import { useState } from "react";

/**
 * Prompt to enter the CFX file decryption password (stored client-side, reused for every
 * `.pltd`/`.prcl`/`.pcrd`). Shared by the raw `.pltd` viewer and the top-level `.pcrd` gate in
 * `App.tsx` — both need the same "we don't ship this password" explanation and retry flow.
 */
export function PasswordPrompt({
  wrong,
  onSubmit,
}: {
  wrong: boolean;
  onSubmit: (pw: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <section className="decoded__block">
      <h3 className="decoded__h">Password required</h3>
      <p className="decoded__hint mono">
        {wrong ? "The saved password did not decrypt this file. " : ""}
        CFX plate/protocol/experiment files are ZipCrypto-encrypted; this app doesn&apos;t ship
        the password. Enter the CFX file password (see <code>pltd.md</code> for how to find it
        in a licensed CFX Manager install). It&apos;s stored in your browser and reused for
        every plate, protocol, and .pcrd file.
      </p>
      <form
        className="plate__pwform"
        onSubmit={(e) => {
          e.preventDefault();
          if (value) onSubmit(value);
        }}
      >
        <input
          type="password"
          className="plate__pwinput mono"
          placeholder="CFX file password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit" className="segmented__item" disabled={!value}>
          Save &amp; decode
        </button>
      </form>
    </section>
  );
}
