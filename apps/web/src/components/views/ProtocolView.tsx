import { useEffect, useRef, useState } from "react";
import { formatRunDefinitionText, type AlfReport, type ProtocolStep } from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { ProtocolStepsTable } from "../raw/ProtocolSteps";
import { ProtocolEditor } from "../protocol/ProtocolEditor";
import { AttachProtocolMenu } from "../protocol/AttachProtocolMenu";
import { ThermalProfileChart } from "../protocol/ThermalProfileChart";
import { DownloadIcon } from "../DownloadIcon";
import { CloneIcon } from "../CloneIcon";
import { RenameIcon } from "../RenameIcon";
import { downloadText } from "../../lib/download";
import { protocolFileBase } from "../../lib/protocolFileBase";
import { fileBytes, type AddFilesOptions, type LoadedFile } from "../../state/useZpcrStore";

/**
 * The Protocol tab — for a standalone `.prcl.txt` and for a run's own protocol alike.
 *
 * **One view, not two.** These used to be separate components (`StandaloneProtocolView` and this
 * one) that had drifted: only one had an editor, only one had the download/clone pair, one led with
 * a stat table of `Method`/`Lid`/`Volume` and the other didn't. But a protocol is a protocol — the
 * same directive text, rendered the same way — and where it is stored changes only two things,
 * both of which are props here:
 *
 * - **whether it may be edited** ({@link editable}), which follows the app's rule about editing what
 *   has already happened (`apps/web/ARCHITECTURE.md`): a standalone file and a *pending* experiment
 *   are drafts, a run that has happened is a record;
 * - **whether there is a thermal profile to show**, which only a run that has actually executed has
 *   (its `.alf` report).
 *
 * The protocol's own **Replace / Download / Clone** buttons ride the "Thermal protocol" heading
 * line in both modes, mirroring the three the Plates tab carries for a plate — see the `toolbar`
 * const below for what each one is and where the two sets deliberately differ.
 *
 * The `Method`/`Lid`/`Volume`/`Steps`/`Plate reads`/`Scan` table the standalone view used to lead
 * with is gone. Every one of those facts is a directive in the listing below it — `HOTLID 105,30`
 * *is* the lid row, annotated in plain English — so the table restated the protocol in a second,
 * shorter form that could only ever agree with it or be a bug.
 *
 * The **name** leads the view, the way an experiment's name leads its Overview, and for the same
 * reason: it is what a person calls the thing, and for a protocol it is genuinely editable (a
 * standalone file has only its filename to be named by; a run's protocol carries `ProtocolName.txt`).
 * A protocol that has just been created has none, and the field says so in the same red the
 * experiment-name field uses.
 */
export function ProtocolView({
  protocolText,
  steps,
  report,
  file,
  files,
  addFiles,
  editable,
  onChangeProtocol,
  onAttachProtocol,
  name,
  onRenameProtocol,
  autoFocusName,
  onAutoFocusHandled,
}: {
  /**
   * The protocol's directive text, or null when there isn't one yet. Deliberately the text and not
   * a `Zpcr`: a standalone `.prcl.txt` has no run around it, and taking the protocol itself is what
   * lets one component serve both callers (see the module comment).
   */
  protocolText: string | null;
  /** The structured step list, when the format carries one of its own (a `.pcrd`/Biomeme run).
   * Preferred over the directive listing when present, as it always was. */
  steps?: ProtocolStep[] | null;
  /** The run's `.alf` report, when it executed and recorded one — the thermal profile below. */
  report?: AlfReport | null;
  /** Only its `name` is used, as the download/clone filename's fallback base. */
  file: { name: string };
  /** Every loaded file, so Replace can offer already-loaded `.prcl.txt` files instead of only a
   * fresh upload — the same list `PlatesView` passes to `AttachPlateMenu`. */
  files: LoadedFile[];
  /** Adds the cloned `.prcl.txt` to the file list — see the Clone button below. */
  addFiles: (files: FileList | File[], options?: AddFilesOptions) => Promise<string | null>;
  /** This protocol is a draft rather than a record, so it may be changed here — a standalone
   * `.prcl.txt`, or a pending experiment's protocol. False for a run that has happened. */
  editable: boolean;
  /** Persist an edited protocol (the store's `setProtocolText`/`setRunProtocolText`). Only called
   * while {@link editable}. */
  onChangeProtocol: (runDefinition: string) => void;
  /**
   * Swap this experiment's protocol for another `.prcl.txt` — the store's `attachProtocol`, and
   * the Replace half of the toolbar. Omitted where there is no experiment to attach to: a
   * standalone `.prcl.txt` *is* the file, so replacing its contents from another file is just
   * opening that other file (the same reason `StandalonePlateView` has no attach control).
   *
   * Only offered while {@link editable}, unlike the plate's, which a finished run still gets:
   * attaching a plate to a run that happened is labelling results that came in without a map,
   * whereas swapping its protocol would rewrite the record of what the instrument actually ran.
   */
  onAttachProtocol?: (file: File) => void;
  /** What this protocol is called, or `""` when it has never been named. */
  name: string;
  /** Store a new name — a rename of the file itself for a standalone `.prcl.txt`, or of the
   * `ProtocolName.txt` entry for a run's. Only offered while {@link editable}. */
  onRenameProtocol: (name: string) => void;
  /** Open the name field focused as soon as this view appears — how a just-created protocol
   * arrives, since naming it is the next thing to do. */
  autoFocusName?: boolean;
  onAutoFocusHandled?: () => void;
}) {
  const header = (
    <ProtocolHeader
      name={name}
      editable={editable}
      onRename={onRenameProtocol}
      autoFocus={autoFocusName}
      onAutoFocusHandled={onAutoFocusHandled}
    />
  );

  const fileBase = `${protocolFileBase(name || null, file.name)}.prcl.txt`;

  /**
   * Replace / Download / Clone — the same three the Plates tab carries, in the same order and
   * spelled the same way (`PlatesView`'s `plateview__toolbar`: the attach menu, then
   * `PlateDownloadButton`'s download and clone). Protocols and plates are the two halves an
   * experiment is assembled from, and having one of them offer all three while the other offered
   * only two was drift, not a distinction.
   *
   * Download and Clone need text to write, so a protocol that is structured-only (a `.pcrd`'s
   * step list) or not there yet gets Replace alone — the same way the Plates tab's empty state
   * shows its attach control and nothing else.
   */
  const toolbar = (
    <>
      {editable && onAttachProtocol && (
        <AttachProtocolMenu
          files={files}
          compactLabel={protocolText ? "replace protocol" : "attach protocol"}
          // Icon-only when it rides the heading line beside download and clone; labelled in the
          // no-protocol state, where it stands alone and is the only thing there is to do. Same
          // split `PlatesView` makes, for the same reason.
          iconOnly={!!protocolText}
          confirmReplace={!!protocolText}
          onSelect={(f) => onAttachProtocol(new File([fileBytes(f).slice()], f.name))}
          onUpload={onAttachProtocol}
        />
      )}
      {protocolText && (
        <>
          <button
            className="raw__download"
            onClick={() => downloadText(fileBase, formatRunDefinitionText(protocolText))}
            aria-label="Download the thermal protocol as .prcl.txt"
            title={
              "Download the ASCII run definition as .prcl.txt — one directive per line. " +
              "This is the form the instrument itself records, and what an experiment loads " +
              "when a protocol is attached to it."
            }
          >
            <DownloadIcon />
          </button>
          <button
            className="raw__download"
            onClick={() => {
              const text = formatRunDefinitionText(protocolText);
              void addFiles([new File([new TextEncoder().encode(text)], fileBase)]);
            }}
            aria-label="Clone the thermal protocol into an independent .prcl.txt file"
            title="Extract this protocol into its own .prcl.txt file, kept alongside your other files"
          >
            <CloneIcon />
          </button>
        </>
      )}
    </>
  );

  // A pending experiment that has no protocol yet. Not an error and not an empty frame with an
  // editor in it: writing a protocol is a deliberate act, and "new protocol" lives on the Overview
  // tab beside the experiment's other missing halves. Attaching one it already has is offered right
  // here, though — that is the same button this view carries once there *is* a protocol, and the
  // same shape the Plates tab's empty state uses for a run with no plate.
  if (!protocolText && !steps?.length) {
    return (
      <div className="overview">
        {header}
        <div className="decoded__na mono">
          {editable
            ? "No protocol yet. Attach a protocol file you already have, or write a new one from " +
              "this experiment's Overview tab."
            : "No thermal protocol for this run."}
        </div>
        <div className="overview__blocktools">{toolbar}</div>
      </div>
    );
  }

  return (
    <div className="overview">
      {header}
      {editable && protocolText ? (
        <ProtocolEditor runDefinition={protocolText} onChange={onChangeProtocol} tools={toolbar} />
      ) : (
        <section className="overview__block">
          <div className="overview__blockhead">
            <h2 className="overview__h">Thermal protocol</h2>
            <div className="overview__blocktools">{toolbar}</div>
          </div>
          {steps?.length ? (
            <ProtocolStepsTable steps={steps} />
          ) : (
            <ProtocolDecoded text={protocolText!} />
          )}
        </section>
      )}

      {/* What the block *actually* did, when the run carries a `.alf` report: the same protocol as
          the instrument executed it, plotted against wall-clock time (`alf.md` §7.6). The pairing is
          the point — the listing above states the intent, the plot below states the cost, and a hold
          that ran 46 s for its nominal 30 is only visible in the second. A standalone protocol, a
          pending experiment and a `.pcrd` have no report, and simply don't get the section. */}
      {report && (
        <section className="overview__block">
          <h2 className="overview__h">Thermal profile as run</h2>
          <p className="decoded__hint">
            A visualization of the <code>.alf</code> run report stored with this run — the
            instrument's own record of what the block actually did, timed against the clock rather
            than against the protocol above. Each step slopes up or down while the block travels to
            its setpoint, then runs flat for the hold at it, so the time a temperature change cost
            is the width of the slope.{" "}
            <span className="thermal__key thermal__key--read">Plate reads</span> are numbered in the
            order they were taken; every read is a point, though only as many numbers are drawn as
            fit. The very first approach isn't drawn — nothing records what the block was at before
            the run started.
          </p>
          <ThermalProfileChart report={report} />
        </section>
      )}
    </div>
  );
}

/**
 * The view's headline: what this protocol is called. Deliberately the same shape as an experiment's
 * name on Overview (`OverviewView`'s `ExperimentHeader`) — a live field while the protocol is a
 * draft, a heading plus a pencil once it is a record — because it is the same question about the
 * same kind of thing, and answering it two different ways in two tabs would be the drift this view's
 * unification exists to undo.
 *
 * An unnamed protocol is marked in red rather than merely left blank, for the reason the experiment
 * field is: a heading-sized box holding a placeholder reads as empty, and empty looks like nothing
 * to do.
 */
function ProtocolHeader({
  name,
  editable,
  onRename,
  autoFocus,
  onAutoFocusHandled,
}: {
  name: string;
  editable: boolean;
  onRename: (name: string) => void;
  autoFocus?: boolean;
  onAutoFocusHandled?: () => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const [editing, setEditing] = useState(false);
  const missing = editable && !name.trim();
  // Unnamed protocols are open from the start — there is nothing to read, only something to answer.
  const live = editable && (missing || editing);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    inputRef.current?.focus();
    onAutoFocusHandled?.();
  }, [autoFocus, onAutoFocusHandled]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === name) return;
    if (!next) {
      setDraft(name);
      return;
    }
    onRename(next);
  };

  const title = editable
    ? "What this protocol is called. It names the file it can be saved as, and travels with the " +
      "experiment it belongs to."
    : "What this protocol is called, as the run recorded it.";

  if (!live) {
    return (
      <header className="overview__title">
        <h1 className="overview__nametext" title={title}>
          {name || "Untitled protocol"}
        </h1>
        {editable && (
          <button
            className="raw__download overview__nameeditbtn"
            onClick={() => setEditing(true)}
            aria-label="Rename this protocol"
            title="Rename this protocol"
          >
            <RenameIcon />
          </button>
        )}
      </header>
    );
  }

  return (
    <header className="overview__title">
      <input
        ref={inputRef}
        className={"overview__name" + (missing ? " is-missing" : "")}
        value={draft}
        autoFocus={editing}
        onFocus={(e) => editing && e.currentTarget.select()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(name);
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        aria-label="Protocol name"
        aria-required={missing || undefined}
        required={missing || undefined}
        placeholder={missing ? "Name this protocol — e.g. RVP fast" : undefined}
        spellCheck={false}
        title={title}
      />
      {missing && (
        <span className="overview__namerequired" title="Required — name this protocol">
          required
        </span>
      )}
    </header>
  );
}
