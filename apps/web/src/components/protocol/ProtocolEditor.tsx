/**
 * The Protocol view's editor for a standalone protocol file (`.prcl.txt`).
 *
 * **It never edits text.** Every change goes through core's `ProtocolBuilder`
 * (`protocolBuilder.ts`, `protocol.md` §10), which owns serialization, step numbering and what a
 * legal protocol is; this component owns only the interaction. Three consequences worth knowing
 * before changing it:
 *
 * - **There is no free-text mode, deliberately.** A protocol is typed at an instrument directive
 *   by directive (`protocol.md` §7) and a malformed one fails at the step, mid-authoring. Editing
 *   the model rather than the string means the file can never hold something the grammar doesn't,
 *   and every field can carry the language's own limits (§3.5) beside it.
 * - **`END` and the step numbers aren't editable, because they aren't state.** `END` is emitted
 *   by the builder; a step's number is its position. Inserting a row renumbers the rest and
 *   repoints every `GOTO` that referred past it — see `ProtocolBuilder.withInsertedStep`.
 * - **Done is not Save.** Edits are written to the file as they're made (rate-limited by
 *   `writeThrottle.ts`, shared with `zpcrweb.json` settings); the Edit/Done button switches the
 *   listing between reading and editing and nothing else.
 *
 * The listing itself is rendered from `parseRunDefinition` of the builder's own output, so what
 * is on screen — step numbers, the plain-English reading beside each row — is a decode of the
 * exact text that would be sent, not a second rendering of the model that could drift from it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ProtocolBuilder,
  parseRunDefinition,
  PROTOCOL_STEP_KINDS,
  type ProtocolHeaderDraft,
  type ProtocolStepDraft,
  type ProtocolStepKind,
} from "@zpcrweb/core";
import { ProtocolDecoded } from "../raw/DecodedView";
import { HeaderForm, StepForm } from "./StepForm";

/** What the open popover is editing. `insert` is a step that doesn't exist yet. */
type OpenTarget =
  | { kind: "header" }
  | { kind: "step"; index: number }
  | { kind: "insert"; index: number };

/** Where the popover sits: measured off the row that opened it (see {@link StepPopover}). */
interface Anchor {
  /** Viewport y of the row's bottom edge — the form's preferred top. */
  top: number;
  left: number;
  /** The row's own height, so the form can be flipped above it when it won't fit below. */
  rowHeight: number;
}

/** The undo stack: every protocol this editing session has produced, and where in it we are. */
interface History {
  stack: string[];
  pos: number;
}

/**
 * Undo/redo over the whole protocol, as a stack of run definitions.
 *
 * Strings rather than builders: they're what gets written to the file anyway, they compare with
 * `===` (so a no-op edit doesn't push an entry onto the stack), and rebuilding a builder from one
 * is cheap. The baseline entry is whatever the file held when editing began, so undo can always
 * get back to it.
 *
 * **The history lives in a ref, mirrored into state for rendering**, and `current` — not the
 * `runDefinition` prop — is what the editor edits. Both are the same value in the steady state;
 * they differ for the moment between an edit being made and the store's new value coming back
 * down as a prop. Reading the prop (or a `useState` snapshot) in that window means acting on the
 * *previous* protocol, which is exactly the sort of bug that only shows up when two edits land in
 * quick succession — a fast click, or a UI test that never pauses to let React settle.
 */
function useProtocolHistory(runDefinition: string, onChange: (text: string) => void) {
  const [history, setHistory] = useState<History>({ stack: [runDefinition], pos: 0 });
  const ref = useRef(history);
  const apply = useCallback((next: History) => {
    ref.current = next;
    setHistory(next);
  }, []);
  // A protocol that changed underneath us — a different file selected, the store re-reading the
  // bytes — restarts the history, rather than leaving undo pointing at another file's protocol.
  //
  // "Underneath us" is judged against the *whole stack*, not against the last value emitted:
  // effects run after their render and several edits can land before the first of them does, so
  // this callback routinely sees a prop that is one of our own values, just not the newest one.
  // Comparing against a single "last emitted" ref treats that lag as an external change and
  // throws the undo history away — which is exactly the bug this shape avoids.
  useEffect(() => {
    if (ref.current.stack.includes(runDefinition)) return;
    apply({ stack: [runDefinition], pos: 0 });
  }, [runDefinition, apply]);

  const commit = useCallback(
    (text: string) => {
      const { stack, pos } = ref.current;
      if (text === stack[pos]) return;
      const next = [...stack.slice(0, pos + 1), text];
      apply({ stack: next, pos: next.length - 1 });
      onChange(text);
    },
    [apply, onChange],
  );

  const undo = useCallback(() => {
    const { stack, pos } = ref.current;
    if (pos === 0) return;
    apply({ stack, pos: pos - 1 });
    onChange(stack[pos - 1] as string);
  }, [apply, onChange]);

  const redo = useCallback(() => {
    const { stack, pos } = ref.current;
    if (pos >= stack.length - 1) return;
    apply({ stack, pos: pos + 1 });
    onChange(stack[pos + 1] as string);
  }, [apply, onChange]);

  return {
    /** The protocol as this editor last left it — see the note above on why not the prop. */
    current: history.stack[history.pos] as string,
    commit,
    undo,
    redo,
    canUndo: history.pos > 0,
    canRedo: history.pos < history.stack.length - 1,
  };
}

/**
 * The form for one row, in a native popover.
 *
 * `popover="auto"` gets top-layer stacking, Escape, and light dismiss (a click anywhere else
 * closes it) from the browser rather than from a document-level listener of our own. Anchor
 * positioning isn't broadly supported yet, so the position is measured off the row once, on open
 * — the listing doesn't scroll under it, so there is nothing to keep in sync.
 */
function StepPopover({
  anchor,
  onClose,
  onCommit,
  canCommit,
  title,
  children,
}: {
  anchor: Anchor;
  onClose: () => void;
  onCommit: () => void;
  canCommit: boolean;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Read inside the layout effect below without making it re-run when only the anchor moves.
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Set through the attribute rather than the property so this doesn't depend on how new the
    // DOM typings are; the behaviour (top layer, Escape, light dismiss) is the browser's either
    // way.
    el.setAttribute("popover", "auto");
    const onToggle = (e: Event) => {
      if ((e as Event & { newState?: string }).newState === "closed") onClose();
    };
    el.addEventListener("toggle", onToggle);
    if (!el.matches(":popover-open")) el.showPopover();
    // A popover is in the top layer, so nothing clips it and nothing scrolls it into view: a row
    // near the bottom of a long protocol would open a form running off the screen. Measure once
    // it's up and pull it back inside — above the row if that's the only way it fits.
    const box = el.getBoundingClientRect();
    const margin = 8;
    if (box.bottom > window.innerHeight - margin) {
      const above = anchorRef.current.top - box.height - anchorRef.current.rowHeight - 8;
      el.style.top = `${Math.max(margin, above > margin ? above : window.innerHeight - box.height - margin)}px`;
    }
    if (box.right > window.innerWidth - margin) {
      el.style.left = `${Math.max(margin, window.innerWidth - box.width - margin)}px`;
    }
    // Put the caret in the first field, so a value can be typed without reaching for the mouse.
    el.querySelector<HTMLElement>("input, select")?.focus();
    return () => {
      el.removeEventListener("toggle", onToggle);
      if (el.matches(":popover-open")) el.hidePopover();
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="stepform__popover"
      style={{ top: `${anchor.top}px`, left: `${anchor.left}px` }}
      role="dialog"
      aria-label={title}
      onKeyDown={(e) => {
        // Enter commits from anywhere in the form — a <select> included, which is why this is on
        // the container rather than on a real <form>'s submit.
        if (e.key === "Enter" && canCommit) {
          e.preventDefault();
          onCommit();
        }
      }}
    >
      <div className="stepform__head">
        <span className="stepform__title">{title}</span>
        <button
          type="button"
          className="stepform__ok"
          onClick={onCommit}
          disabled={!canCommit}
          title={canCommit ? "Apply this change (Enter)" : "Fix the values above first"}
          aria-label="Apply"
        >
          ✓
        </button>
      </div>
      {children}
    </div>
  );
}

export function ProtocolEditor({
  runDefinition,
  onChange,
  fileName,
}: {
  runDefinition: string;
  /** Persist an edited protocol — the store's `setProtocolText`, throttled on its own. */
  onChange: (runDefinition: string) => void;
  fileName: string;
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<OpenTarget | null>(null);
  const [anchor, setAnchor] = useState<Anchor>({ top: 0, left: 0, rowHeight: 0 });
  /** The value being edited in the popover, applied to the file only on commit. */
  const [draftStep, setDraftStep] = useState<ProtocolStepDraft | null>(null);
  const [draftHeader, setDraftHeader] = useState<ProtocolHeaderDraft | null>(null);

  const { current, commit, undo, redo, canUndo, canRedo } = useProtocolHistory(
    runDefinition,
    onChange,
  );

  // The builder is the editable form; `loadError` is why a protocol has no editor — an unknown
  // verb, an unfamiliar scan mask (see `ProtocolBuilder.fromRunDefinition`). Refusing to edit is
  // the honest answer there: the alternative is silently rewriting what we didn't understand.
  const { builder, loadError } = useMemo(() => {
    const result = ProtocolBuilder.tryFromRunDefinition(current);
    return { builder: result.builder ?? null, loadError: result.error ?? null };
  }, [current]);

  const program = useMemo(() => parseRunDefinition(current), [current]);

  const closePopover = useCallback(() => {
    setOpen(null);
    setDraftStep(null);
    setDraftHeader(null);
  }, []);

  // Leaving edit mode (or losing the editable builder) must not strand an open form.
  useEffect(() => {
    if (!editing || !builder) closePopover();
  }, [editing, builder, closePopover]);

  // Ctrl-Z / Ctrl-Y, with the platform's Cmd-Shift-Z spelling of redo too. Skipped while a field
  // has focus, where the browser's own undo for that field is what the keystroke should mean.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, undo, redo]);

  /** Open a row's form, measuring where to put it from the row itself. */
  const openAt = (target: OpenTarget, event: { currentTarget: HTMLElement }) => {
    if (!builder) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({
      top: Math.round(rect.bottom + 4),
      left: Math.round(rect.left),
      rowHeight: Math.round(rect.height),
    });
    if (target.kind === "header") {
      setDraftHeader(builder.header);
      setDraftStep(null);
    } else {
      const step =
        target.kind === "step"
          ? builder.step(target.index)
          : builder.defaultStep(firstInsertableKind(builder, target.index), target.index);
      setDraftStep(step ?? null);
      setDraftHeader(null);
    }
    setOpen(target);
  };

  /** Step numbers a GOTO at this position may target, with a description of each. */
  const legalTargets = useMemo(() => {
    if (!builder || !open || open.kind === "header") return [];
    return builder.legalGotoTargets(open.index);
  }, [builder, open]);

  const targetLabels = useMemo(() => {
    const map = new Map<number, string>();
    for (const d of program.steps) if (d.stepNumber) map.set(d.stepNumber, d.text);
    return map;
  }, [program]);

  const draftIssues = useMemo(() => {
    if (!builder) return [];
    if (draftHeader) {
      return builder
        .withHeader(draftHeader)
        .validate()
        .filter((i) => i.stepIndex === undefined);
    }
    if (draftStep && open && open.kind !== "header") {
      const next =
        open.kind === "step"
          ? builder.withStep(open.index, draftStep)
          : builder.withInsertedStep(open.index, draftStep);
      return next.validate().filter((i) => i.stepIndex === open.index);
    }
    return [];
  }, [builder, draftHeader, draftStep, open]);

  const applyDraft = () => {
    if (!builder || !open || draftIssues.length > 0) return;
    let next: ProtocolBuilder | null = null;
    if (open.kind === "header" && draftHeader) next = builder.withHeader(draftHeader);
    else if (open.kind === "step" && draftStep) next = builder.withStep(open.index, draftStep);
    else if (open.kind === "insert" && draftStep)
      next = builder.withInsertedStep(open.index, draftStep);
    if (next) commit(next.toRunDefinition());
    closePopover();
  };

  const removeStep = (index: number) => {
    if (!builder) return;
    closePopover();
    commit(builder.withoutStep(index).toRunDefinition());
  };

  const editable = builder !== null;
  const canEdit = editing && editable;

  return (
    <section className="overview__block">
      <div className="overview__blockhead">
        <h2 className="overview__h">Thermal protocol</h2>
        <div className="overview__blocktools">
          {canEdit && (
            <>
              <button
                type="button"
                className="btn btn--sm"
                onClick={undo}
                disabled={!canUndo}
                title="Undo (Ctrl-Z)"
              >
                ↶ Undo
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={redo}
                disabled={!canRedo}
                title="Redo (Ctrl-Y)"
              >
                ↷ Redo
              </button>
            </>
          )}
          <button
            type="button"
            className={"btn btn--sm" + (canEdit ? " btn--primary" : "")}
            onClick={() => setEditing((v) => !v)}
            disabled={!editable}
            title={
              editable
                ? editing
                  ? "Stop editing — changes are already saved"
                  : "Edit this protocol"
                : `This protocol can't be edited: ${loadError}`
            }
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      <span className="decoded__hint mono">
        {fileName} — the pure text run definition. Stage it against a plate on the Instrument tab.
        {editing && " Click a line to change it; edits are saved as you make them."}
      </span>

      {!editable && !editing && (
        <div className="decoded__hint mono protoedit__note">Not editable: {loadError}</div>
      )}

      {/* The same listing in both modes, inert until Edit is pressed — not a different rendering
          that happens to look similar. Reading and editing then have identical geometry: the +/−
          gutter is reserved, empty, while reading, so pressing Edit lights the rows up where they
          already are instead of reflowing the program sideways. A protocol with no builder behind
          it has no groups to draw, and falls back to the plain listing. */}
      {builder ? (
        <EditableListing
          builder={builder}
          program={program}
          interactive={canEdit}
          onOpen={openAt}
          onRemove={removeStep}
          openTarget={open}
        />
      ) : (
        <ProtocolDecoded text={current} />
      )}

      {canEdit && open && (
        <StepPopover
          anchor={anchor}
          onClose={closePopover}
          onCommit={applyDraft}
          canCommit={draftIssues.length === 0}
          title={
            open.kind === "header"
              ? "Protocol settings"
              : open.kind === "insert"
                ? `New step ${open.index + 1}`
                : `Step ${open.index + 1}`
          }
        >
          {open.kind === "header" && draftHeader && (
            <HeaderForm header={draftHeader} onChange={setDraftHeader} />
          )}
          {open.kind !== "header" && draftStep && builder && (
            <StepForm
              step={draftStep}
              onChange={setDraftStep}
              legalTargets={legalTargets}
              targetLabels={targetLabels}
              onKindChange={(kind: ProtocolStepKind) =>
                setDraftStep(builder.defaultStep(kind, open.index))
              }
            />
          )}
        </StepPopover>
      )}
    </section>
  );
}

type Directive = ReturnType<typeof parseRunDefinition>["directives"][number];

/** One editable thing, and the consecutive directives that spell it out. */
interface Group {
  key: number;
  directives: Directive[];
  /** The form this group opens, or `null` for `END`, which is the editor's own and not editable. */
  target: OpenTarget | null;
  /** The step this group *is*, for the delete button; `null` for the header and for `END`. */
  stepIndex: number | null;
  /** Where this group's + inserts, or `null` where there is no + (`END`). */
  insertAt: number | null;
}

/**
 * Fold the directive list into the things a person edits.
 *
 * The rules are the grammar's (`protocol.md` §3.2): the header directives lead the file, a
 * directive that carries a step number opens a step, and one that doesn't is a modifier on the
 * step above it. `END` is last and stands alone — it can't be edited or deleted, and it carries no
 * + either: appending past the final step is what the last step's own + does, so a second button
 * for the same insertion would be one gap with two ways to fill it. Every *other* group gets a +
 * that inserts directly below it, the header's included — that one is the only way to put a step
 * before what is currently step 1.
 */
function groupDirectives(program: ReturnType<typeof parseRunDefinition>): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const d of program.directives) {
    const isHeader = d.verb === "METHOD" || d.verb === "HOTLID" || d.verb === "VOLUME";
    const isEnd = d.verb === "END";
    // A header directive joins an open header; a modifier — anything with no step number of its
    // own — joins the step above it. Everything else starts a group.
    const continues =
      current !== null &&
      !isEnd &&
      (isHeader ? current.target?.kind === "header" : d.stepNumber === undefined);
    if (continues && current) {
      current.directives.push(d);
      continue;
    }
    const stepIndex = d.stepNumber !== undefined ? d.stepNumber - 1 : null;
    current = {
      key: d.index,
      directives: [d],
      target: isEnd ? null : isHeader ? { kind: "header" } : { kind: "step", index: stepIndex ?? 0 },
      stepIndex: isEnd || isHeader ? null : stepIndex,
      insertAt: isEnd ? null : isHeader ? 0 : (stepIndex ?? 0) + 1,
    };
    groups.push(current);
  }
  return groups;
}

/** The first step kind that can go at `index` — only `GOTO` is ever unavailable there. */
function firstInsertableKind(builder: ProtocolBuilder, index: number): ProtocolStepKind {
  return PROTOCOL_STEP_KINDS.find((k) => builder.canInsert(k, index)) ?? "temp";
}

/**
 * The directive listing: the same lines {@link ProtocolDecoded} draws, and — once `interactive` —
 * a click target that opens each group's form, with insert/delete in a gutter to the left of the
 * step numbers, so that form has the width of the panel to lay itself out in rather than opening
 * hard against the right edge (see the `.protoedit__line` rules).
 *
 * The listing is drawn by this component in both modes, so reading and editing have identical
 * geometry: the gutter is reserved while reading, and Edit lights up rows already in place.
 *
 * Lines come from a decode of the builder's own text, so a modifier (`BEEP`, `INC`, `RATE`, …)
 * appears on its own line as it does in the file — but **the unit of editing is not the line, it
 * is the thing the line belongs to**, and the listing is grouped to match: `METHOD`/`HOTLID`/
 * `VOLUME` are one settings form (`HeaderForm`), and a step is its directive plus whichever
 * modifiers ride on it (`protocol.md` §3.2), all edited by the one `StepForm`.
 *
 * So a group is drawn as a run of lines inside a *single* click target with a *single* +/− pair:
 * one highlight rather than three lit at once, one delete that removes the step and its modifiers
 * together, and a form that — anchored off the target's bottom edge — opens below the whole group
 * rather than through the middle of it.
 */
function EditableListing({
  builder,
  program,
  interactive,
  onOpen,
  onRemove,
  openTarget,
}: {
  builder: ProtocolBuilder;
  program: ReturnType<typeof parseRunDefinition>;
  /** False while the protocol is only being read: same rows, same metrics, nothing to click. */
  interactive: boolean;
  onOpen: (target: OpenTarget, event: { currentTarget: HTMLElement }) => void;
  onRemove: (index: number) => void;
  openTarget: OpenTarget | null;
}) {
  const groups = groupDirectives(program);

  return (
    <div className="decoded protoedit">
      <div className="decoded__proto mono">
        {groups.map((group) => {
          const isOpen =
            group.target !== null &&
            (group.target.kind === "header"
              ? openTarget?.kind === "header"
              : openTarget?.kind === "step" && openTarget.index === group.target.index);
          // Captured per group: a handler reading a running value at click time would act on
          // whichever group happened to be last.
          const { stepIndex, insertAt } = group;
          const target = interactive ? group.target : null;
          const lines = group.directives.map((d) => (
            <span key={d.index} className="decoded__protoline">
              <span className="decoded__protonum">{d.stepNumber ?? ""}</span>
              <span className="decoded__prototext">{d.text};</span>
              <span className="decoded__protonote">{d.description}</span>
            </span>
          ));
          return (
            <div
              key={group.key}
              className={"protoedit__line" + (isOpen ? " is-open" : "")}
            >
              <span className="protoedit__rowtools">
                {interactive && insertAt !== null && (
                  <button
                    type="button"
                    className="protoedit__iconbtn protoedit__iconbtn--ins"
                    title={
                      insertAt === 0
                        ? "Add a step before step 1"
                        : `Add a step after step ${insertAt}`
                    }
                    aria-label="Add a step below"
                    onClick={(e) => onOpen({ kind: "insert", index: insertAt }, e)}
                  >
                    +
                  </button>
                )}
                {interactive && stepIndex !== null && (
                  <button
                    type="button"
                    className="protoedit__iconbtn protoedit__iconbtn--del"
                    title={`Delete step ${stepIndex + 1}`}
                    aria-label="Delete this step"
                    onClick={() => onRemove(stepIndex)}
                  >
                    −
                  </button>
                )}
              </span>
              {target ? (
                <button
                  type="button"
                  className="protoedit__rowbtn"
                  onClick={(e) => onOpen(target, e)}
                >
                  {lines}
                </button>
              ) : (
                <span className="protoedit__rowbtn is-inert">{lines}</span>
              )}
            </div>
          );
        })}
      </div>
      {/* Below the listing, so showing it only in edit mode moves nothing that was already read. */}
      {interactive && (
        <div className="protoedit__legend mono">
          {builder.stepCount} step{builder.stepCount === 1 ? "" : "s"} · steps renumber themselves ·
          END is written by the editor and can&apos;t be moved or removed
        </div>
      )}
    </div>
  );
}
