/**
 * Follow a run that is happening right now, and keep a `.zpcr` of it in the caller's file list.
 *
 * **`STATUS?` is the progress signal, not the filesystem** (`usb.md` §7.5). Its current-step field
 * carries the running step's command text verbatim, and a completed `.Plateread` appears in the
 * run folder when that step *ends* — so the rule is to watch for the step leaving a `PLATEREAD`
 * and list the directory then, rather than polling the filesystem hopefully. `CfxSession`'s status
 * poll is already running, so this costs nothing extra and reacts within a poll period instead of
 * within a listing period.
 *
 * Listing the folder is entirely **edge-triggered**, never on a timer: a `GETFILESLEN`+
 * `LISTALLFILES` round trip holds the session's `busy` flag, and a periodic listing here used to
 * flicker the Instrument rail's Start-run button (which disables while `busy`) every 30 s, even
 * with no run in progress. What's left is exactly §7.5/§7.7's own two triggers — the step-transition
 * rule above for every read but the last, and the §7.6 acknowledgement, which is also where the
 * **last** read — `PLATEREAD` → `IDLE` — actually becomes listable — plus one baseline listing on
 * connect, needed only to make the "first listing is never downloaded" rule work at all. Nothing
 * here lists on a run merely *starting*: usb.md doesn't call for it, and `STATUS?`'s `running` flag
 * already says so live without a listing — the `begun` marker is a property of the archive this
 * assembles, not of what a rail shows moment to moment, so it can wait for the first listing a real
 * edge triggers anyway. That edge is watched, though, purely to tell a run *starting* from one
 * *found* already going (a reconnect, or a page load mid-run) — the two produce an identical
 * listing, but only the live `running` false→true transition tells them apart, which is what lets
 * the file that transition's next listing eventually produces be selected unconditionally (see
 * {@link RunFollowerPorts.onRun}'s `activate`).
 *
 * When a listing turns out to differ from the last one, whatever is new is pulled and handed to
 * {@link RunFollowerPorts.onRun}, which merges it into the file of that name — what goes over is
 * what the instrument just wrote, not the folder re-assembled. Nothing is zipped on the way: a run
 * still going is kept open and appended to, and only the end-of-run snapshot becomes an ordinary
 * `.zpcr` file. What that name is comes from `runFolder.ts`: the file name typed for a run this
 * app started, and otherwise whatever the run itself says it is called.
 *
 * Three things make that affordable enough to do every cycle:
 *
 * - **Only new files are fetched, and the run's own file says which those are.** A `CurrentRun` is
 *   ~40 files, 28 of which are the `.Dcal` calibration set that never changes during a run;
 *   re-pulling those every cycle would put megabytes over a 64-byte-packet bulk endpoint for
 *   nothing. So each pass reads back the archive the app is holding for this run
 *   ({@link RunFollowerPorts.heldRun}) and fetches only what it lacks (`runFilesToFetch`) — a file
 *   the instrument has written is final, and a new plate read arrives under a new name, so a
 *   cycle's download is exactly one 22 KB read. The files that *are* rewritten as the run goes
 *   ({@link REFETCH_AT_END}) are re-read once, on the end-of-run pass, where the archive has to be
 *   complete.
 *
 *   **Nothing is remembered here about what has been downloaded** — the app's copy of the run *is*
 *   that record. This used to keep its own name→bytes map of the folder, which was the same
 *   ~400 KB held twice and could disagree with the file the user actually has: delete a run
 *   mid-way and the follower went on believing it had every byte, so the file never came back. Now
 *   the question "what do we have?" has one answer, and a run whose file is gone is downloaded
 *   again from the top, finished or not.
 * - **The first listing is never downloaded — unless it's already running.** `CurrentRun` usually
 *   holds the *previous* run when you connect, finished and complete with its `ended` marker.
 *   Pulling that unasked would be a surprise 400 KB transfer and an unrequested file in the bar,
 *   so the first sighting ordinarily only records the listing to compare later ones against.
 *   But the folder can just as well hold a run that is genuinely `begun` and not yet `ended` — a
 *   browser reload mid-run, or the instrument only plugged in (or connect only pressed) after the
 *   run had already started — and there the "wait for the next change" rule would leave the file
 *   bar showing nothing for up to a whole cycle. `runProgressFromNames` (`runFolder.ts`) tells the
 *   two apart from the same listing, so an in-progress first sighting is pulled immediately
 *   instead of waited out.
 * - **Nothing is stored about "in progress".** The assembled archive carries the `begun` marker
 *   and not `ended`, which is the whole of how the rest of the app knows (see `runFolder.ts`).
 *   Reload the page mid-run and the file still reads as in-progress, because the fact lives in
 *   the file.
 *
 * The one command this issues that *changes* the instrument is the §7.6 acknowledgement — see
 * {@link RunFollowerMemory.watchedRuns} for why it is both safe and necessary.
 *
 * **It is a state machine, and it says so.** Everything it believes lives in one
 * {@link RunFollowerMemory}, advanced by {@link RunFollower.observe} — one call per `STATUS?`.
 * This used to be eleven `useRef` latches spread over four React effects: each was correct, and
 * collectively they were a machine nothing could print and nothing could assert.
 */
import {
  hasRunIdentity,
  isSameRun,
  runFilesToFetch,
  runIdentityFileNames,
  runProgressFromNames,
  zpcrNameForRunFolder,
  zpcrNameFromRunFiles,
  type RunFolderNaming,
} from "../runFolder.js";
import { USB_TRAFFIC_LOG_NAME } from "../usbTraffic.js";
import { CFX_CURRENT_RUN_DIR } from "./runPlan.js";
import { isFinishedRun } from "./status.js";
import type { ZpcrArchive } from "../archive.js";
import type { CfxSession, ConnectionState } from "./session.js";
import type { CfxStatus } from "./status.js";

/**
 * Files whose *content* changes while the run goes on, so the copy in the run's archive goes stale
 * — re-read **only on the end-of-run pass**, never per cycle.
 *
 * Everything else in the folder is written once and never revised: the `.Dcal` set, the plate,
 * the protocol and `GlobData.xml` at the start, and each `Read0000N.Plateread` as its cycle ends
 * — a new read means a new *name*, which the archive doesn't have and so is fetched anyway. So a
 * cycle's download is exactly the 22 KB read that cycle produced.
 *
 * Two of these genuinely grow: `runlog.xml` accumulates an entry per event (31 KB by the end of a
 * 45-cycle run) and `lastplatereadstatus` is a 16-byte record whose payload is the completed-read
 * count. Re-pulling those every cycle was ~40 KB per cycle on top of the 22 KB read — over a
 * 64-byte bulk endpoint, and behind the session's `busy` flag, which stalls the status poll for
 * the duration — to refresh two things nothing consumes until the run is over. Only the final
 * archive needs them complete, so that is the only pass that re-reads them, and a run in progress
 * carries the copy it first saw (visible in the Raw view's run log, which is that far behind
 * mid-run and correct once the run ends).
 *
 * `RunInfo.xml` is here for a different reason: it isn't rewritten during a run, but it is
 * *deposited* by this app after the run starts (`usb.md` §7.4) and survives in the folder from the
 * previous run until it is, so the one re-read at the end costs 8 KB once and removes any question
 * of a run's file holding the previous run's metadata.
 *
 * `ProtocolName.txt` is deliberately **not** here. It only appears at the finish, so an archive
 * without it fetches it on that pass regardless — and listing it would re-read it over a protocol
 * name the user had edited during the run.
 */
const REFETCH_AT_END = new Set(["runinfo.xml", "runlog.xml", "lastplatereadstatus"]);

/** The last path component of a file's id — a disk-backed file's is its path within its folder. */
function baseNameOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/** Identity of a listing, for "has anything changed?" — order-independent. */
function signatureOf(names: readonly string[]): string {
  return [...names].sort().join(" ");
}

/** True when `STATUS?`'s step text is a plate read (`usb.md` §7.5's live echo of §3.1). */
function isPlateRead(stepText: string | null | undefined): boolean {
  return !!stepText && /^PLATEREAD\b/i.test(stepText.trim());
}

/** A run the app is already holding: the file's id, and the entries it holds. */
export interface HeldRun {
  /** The id the run is filed under — a bare name, or a folder-rooted path for a disk-backed file. */
  id: string;
  files: ZpcrArchive;
}

/**
 * Why the folder is being listed — and, since these are the *only* four reasons, what the pass
 * does about what it finds.
 *
 * | reason | lists because | forced? | attaches the traffic log? |
 * |---|---|---|---|
 * | `baseline` | a connection just came up | no | no |
 * | `edge` | a `PLATEREAD` step just ended | no | no |
 * | `final` | the run finished and was acknowledged | yes | yes |
 * | `download` | the user asked for the run on the instrument | yes | yes |
 *
 * This replaces a `check(force, finalAssembly)` whose two booleans were four combinations of which
 * three were used — and the fourth, forced-but-not-final, was how the Download button produced a
 * run with no traffic log in it however the "save log" switch was set. There is no way to spell
 * that combination any more.
 */
export type CheckReason = "baseline" | "edge" | "final" | "download";

/** Everything the follower believes, in one place — readable, printable and assertable. */
export interface RunFollowerMemory {
  /** Whether this connection has established *which file* the run in the folder belongs to. Not a
   * copy of anything: the answer is a name, and the run itself lives only in that file. Cleared on
   * a disconnect and whenever the folder is cleared for a different run, both of which mean the
   * question has to be asked again. */
  identified: boolean;
  /** The last listing seen, for "has anything changed?" and "is this still the same run?". Names
   * only — it says what the instrument's folder holds, not what is in any of it. */
  lastNames: readonly string[] | null;
  /** Whether the baseline listing has been asked for on this connection — once, whether or not it
   * succeeded, so a folder that refuses to list doesn't get re-listed on every poll. */
  baselineAsked: boolean;
  /** Set on the `running` false→true edge, and consumed by the next successful pull — that pull is
   * the file it belongs to. */
  activateNext: boolean;
  /** A run being pulled must not have a second pull started on top of it: the fetch is slow (many
   * sequential commands) and two edges can land at once. */
  pulling: boolean;
  /** Set by the end-of-run pass when the folder turned out not to be this run's. */
  staleAtFinish: boolean;
  /** True while the §7.6 finish is being collected — the window in which the step-transition rule
   * must stand down, since the last read appears only when the acknowledgement releases it. */
  finishing: boolean;
  /** Armed by {@link RunFollower.expectReportOnly} when the run being started is known in advance
   * to write no run folder. Cleared as each run finishes, so it never carries over to the next. */
  reportOnly: boolean;
  /** `STATUS?`'s step text as of the last observation — the step-transition rule's other half. */
  lastStep: string | null;
  /** The run whose §7.6 finish has already been acted on, so a repeat observation can't send the
   * acknowledgement twice. */
  acknowledged: string | null;
  /**
   * Every run **this page session saw cycling**, by name. The §7.6 acknowledgement only ever
   * applies to one of these, and that guard is what stops it firing on connect: an instrument left
   * holding a run that finished yesterday presents exactly the same status, and acknowledging that
   * one would both send an unasked-for command and drag a 400 KB archive nobody requested into the
   * file bar — the same reason a first listing that turns out to be that stale finished run is
   * never pulled.
   *
   * Remembered for the whole page session, and deliberately **surviving a disconnect**. A run that
   * finishes while the cable is out comes back as exactly the status this acknowledges — IDLE,
   * still holding the run — and a latch reset on disconnect would take the reconnected session for
   * a stranger and leave the run held forever: no final plate read, no `ended` marker, no `.alf`,
   * and a file stuck reading as in progress with nothing able to release it. Keyed by name rather
   * than a boolean so the reconnected session still refuses a *different* run it never saw
   * cycling. A page reload is still a stranger by design — memory is all there is to go on, and a
   * reload has none.
   */
  watchedRuns: Set<string>;
  /** Tracks `status.running` purely to catch its false→true edge. Distinct from
   * {@link watchedRuns}, which never forgets; this one un-latches so the next start is caught. */
  wasRunning: boolean;
  /**
   * The instrument's own elapsed-time counter (`CfxStatus.elapsedS`), captured while it's still
   * running: once `status.running` goes false the field itself is no longer meaningful (it's reset
   * for the next run), so this is the only place a completed run's total time can be read from.
   * Held across the whole run, and across a disconnect too, where it is the last time seen before
   * the cable went rather than the true total. Under-reporting the duration of a run nobody was
   * watching the end of beats showing zero for it.
   */
  lastElapsed: number | null;
}

/** What a view renders — see {@link RunFollower.state}. */
export interface RunFollowerState {
  /** True while the follower is following — it still observes, so it still resets on a disconnect. */
  watching: boolean;
  /** What the follower last did, for a rail to show. */
  note: string | null;
  /** The id of the file the follower most recently put in the store, if it is still there. */
  fileName: string | null;
  /**
   * Set once a run this session watched running has finished and its final `.zpcr` has been
   * assembled: what it was called, how long it ran, and the id of that final file — everything a
   * "Run complete" banner needs. Null the rest of the time, including while the §7.6
   * acknowledgement is still in flight (the banner is for a run that's actually done, not merely
   * idle-and-held).
   */
  finished: { name: string; totalS: number; fileName: string } | null;
  /**
   * A run sitting on the instrument that this browser **isn't holding** — what it is called and
   * how far it got. Null whenever the folder's run is already in the file bar, or holds no run at
   * all.
   *
   * This is the answer to "I connected after the run finished, where is it?". A finished run in
   * the folder is deliberately never pulled on sight (see the module comment: it is usually the
   * *previous* run, and a surprise 400 KB transfer plus an unrequested file is not what connecting
   * asks for) — but saying nothing about it left the only way in as the Files panel's "Open run",
   * behind a collapsed disclosure titled as a storage browser. So the fact is offered instead of
   * acted on: the rail says a run is there and unheld, and {@link RunFollower.downloadAvailable}
   * is the click.
   *
   * Costs the same ~8 KB identity read a pass already does (`runIdentityFileNames`), once per
   * connection, and answers exactly — the run's own `RunInfo.xml` against the file's
   * (`isSameRun`), not a guess from the name.
   *
   * `into` is the file the download would land in, when that is one the user already has open: the
   * pending experiment this run was started from, which holds none of the run yet and so cannot be
   * recognised by `isSameRun`. Saying "a run you don't have" about a run whose own file is sitting
   * open in the bar reads as a mistake — the accurate claim is that the *data* hasn't been
   * collected yet, and this is where it will go. Null when the run would arrive as a new file,
   * which is the ordinary case.
   */
  available: { name: string; plateReads: number; inProgress: boolean; into: string | null } | null;
}

export interface RunFollowerPorts {
  /**
   * Read back the entries of a run this app is holding, or `null` if it isn't holding that run.
   *
   * Answers with the **id** it found the run under as well as its entries, because that id is not
   * always the name asked for: a run's name comes from the instrument's folder and is bare, while
   * a file opened out of a granted folder is keyed by its path within it. Taking that answer back
   * is what keeps every later snapshot landing on that one file.
   *
   * **This is the follower's only memory of what it has downloaded.** The run's file is the app's
   * copy of the run, so keeping a second copy here — as this used to, a name→bytes map of the
   * whole folder — was the same ~400 KB stored twice, and the two could disagree: the file was
   * where the user's edits went and the map was what the next pass believed the instrument's
   * folder to be. Asking the file instead makes "what do we have?" a question with one answer.
   * Delete a run mid-way and the next pass sees an empty hand and fetches all of it again, run
   * finished or not; keep it and the pass fetches the one plate read that arrived.
   */
  heldRun: (fileName: string) => HeldRun | null;
  /**
   * Hand what the instrument has written to the app.
   *
   * **`archive` is what this pass wrote, not the whole run** — normally one plate read, and at the
   * end of a run the last read plus `ended`, the `.alf` report and the three
   * {@link REFETCH_AT_END} files. The store merges it into the file of this name, so a run being
   * followed grows by exactly what arrived and everything else about the file is left alone.
   *
   * `whole: true` marks the one pass that *is* the whole folder — the first of the session, or the
   * first after the folder was cleared for a different run — where there is nothing to merge into
   * and the archive stands as the file's entire content.
   *
   * That split is what keeps a plate attached to a run in progress attached. Every pass used to
   * hand over the whole folder, which is the instrument's copy of the run and knows nothing of
   * anything the app added on top: the next plate read — or, most visibly, the end-of-run pass —
   * put the instrument's own plate back and dropped the one the user had swapped in. Handing over
   * only what the instrument actually wrote means an entry it never touched cannot be overwritten
   * by it, and `runFilesToFetch` makes sure the folder's plate isn't even fetched into a run that
   * already has one.
   *
   * `previousId` is the file this one supersedes, so the caller can decide whether to follow the
   * new copy (the user was looking at it) or leave the selection alone. `activate` overrides that:
   * select this file whatever the user was looking at. It is true for the two files someone just
   * *caused to exist* and expects to be looking at — a run that **began while this session was
   * watching** (as opposed to one already going when the folder was first listed, which looks
   * identical in the listing and is told apart only by the live `running` false→true edge), and a
   * run the user asked for by clicking **Download run**.
   *
   * Returns the new file's id.
   */
  onRun: (
    run: { name: string; archive: ZpcrArchive; whole: boolean },
    previousId: string | null,
    activate: boolean,
  ) => Promise<string | null>;
  /**
   * Put a finished run's `.alf` report in the file bar, selected, and hand back its id.
   *
   * The counterpart to {@link onRun} for a run that produced no run folder. Kept separate rather
   * than folded into `onRun` because the two hand over different things: `onRun` merges an archive
   * into a run's own file, and this adds a plain file of a different kind, through the same path a
   * dropped file takes.
   */
  onReport: (name: string, bytes: Uint8Array) => Promise<string | null>;
  /**
   * What the run's name should be derived from, when this app is the one that started it. Read
   * through a function so a keystroke in a name field costs nothing here. Only the archive's
   * *name* depends on it, and only for a run this app started and is still staging —
   * `zpcrNameForRunFolder` decides that from the `zpcrweb.json` in the folder, so a run started at
   * the touchscreen keeps the name the instrument gave it whatever is typed.
   */
  naming?: () => RunFolderNaming | undefined;
}

export class RunFollower {
  readonly #session: CfxSession;
  readonly #ports: RunFollowerPorts;
  readonly #listeners = new Set<() => void>();
  #snapshot: RunFollowerState | null = null;
  /** Serialises {@link RunFollower.observe}'s listings — see {@link RunFollower.#check}. */
  #queue: Promise<unknown> = Promise.resolve();

  #ui: RunFollowerState = {
    watching: true,
    note: null as string | null,
    fileName: null as string | null,
    finished: null as RunFollowerState["finished"],
    available: null as RunFollowerState["available"],
  };

  readonly #m: RunFollowerMemory = {
    identified: false,
    lastNames: null,
    baselineAsked: false,
    activateNext: false,
    pulling: false,
    staleAtFinish: false,
    finishing: false,
    reportOnly: false,
    lastStep: null,
    acknowledged: null,
    watchedRuns: new Set(),
    wasRunning: false,
    lastElapsed: null,
  };

  constructor(session: CfxSession, ports: RunFollowerPorts) {
    this.#session = session;
    this.#ports = ports;
  }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  get state(): RunFollowerState {
    this.#snapshot ??= { ...this.#ui };
    return this.#snapshot;
  }

  /** What the follower currently believes — for a test to assert on, and for a human to print. */
  get memory(): Readonly<RunFollowerMemory> {
    return this.#m;
  }

  #set(patch: Partial<RunFollowerState>): void {
    let any = false;
    for (const [k, v] of Object.entries(patch)) {
      if ((this.#ui as unknown as Record<string, unknown>)[k] !== v) {
        (this.#ui as unknown as Record<string, unknown>)[k] = v;
        any = true;
      }
    }
    if (!any) return;
    this.#snapshot = null;
    for (const fn of this.#listeners) fn();
  }

  setWatching(on: boolean): void {
    this.#set({ watching: on });
  }

  /**
   * The seed is this run's first file, so the follower treats it exactly as one of its own
   * snapshots from here on: the pending experiment the run was started from
   * (`core/experimentArchive.ts`), which is the first version of the very run about to be
   * followed. Without this the first pull would report `previousId: null`, and a caller using that
   * to decide whether the user was looking at the file being superseded would leave them on the
   * seed while the real snapshots piled up beside it.
   *
   * Adopting a seed is the opposite claim to {@link expectReportOnly}'s — this run *has* a file —
   * so it also disarms it, which is what keeps a thermal-only start that never ran (cancelled, or
   * the send failed) from being remembered against the next run.
   */
  adopt(id: string): void {
    this.#m.reportOnly = false;
    this.#set({ fileName: id });
  }

  clearFinished(): void {
    this.#set({ finished: null });
  }

  /**
   * Say that the run about to be started will leave no run folder behind, so this follower should
   * expect its `.alf` report and nothing else (for a thermal-only protocol — see
   * `RunPlan.producesRunFile`).
   *
   * An optimisation of honesty rather than of bytes: the report path is reached anyway when the
   * end-of-run listing turns out unchanged, so a thermal-only run started from the instrument's
   * own touchscreen gets the same treatment. Saying so in advance only skips the listing that
   * would discover it, and stops the run's last moments being spent fetching a folder we already
   * know isn't ours.
   */
  expectReportOnly(): void {
    this.#m.reportOnly = true;
    // Nothing of this run will land in a file of ours, so the follower stops speaking for whatever
    // file it was last following — otherwise the previous run's id would be reported as this run's
    // when it ends.
    this.#set({ fileName: null, finished: null });
  }

  /**
   * Download the run on offer, whole — the rail's button.
   *
   * `identified` is cleared first so the pass re-derives which file the folder's run belongs to
   * rather than trusting an answer from before the user asked.
   */
  async downloadAvailable(): Promise<void> {
    this.#m.identified = false;
    // Asked for, so it is what the user wants to be looking at when it lands — the same override
    // a run starting during this session gets (see `onRun`'s `activate`).
    this.#m.activateNext = true;
    this.#set({ note: "Downloading the run on the instrument…" });
    // A run that finished while this session wasn't watching is still *held* by the instrument
    // (§7.6), and the folder is correspondingly short of the run's last moments: acknowledging is
    // what makes the final plate read, the `ended` marker and the `.alf` report appear. Collecting
    // without it would file a run missing its last cycle and reading as in progress for ever, with
    // nothing left in the app to finish it. The finished-run rule deliberately won't acknowledge a
    // run it never saw cycling — but this is the user asking for exactly this run, which is the
    // consent that judgement was waiting for. Safe for the in-progress offer too:
    // `acknowledgeFinishedRun` re-reads the status and sends nothing to a run still cycling.
    await this.#session.acknowledgeFinishedRun();
    await this.#check("download");
  }

  // --- the transition --------------------------------------------------------------------------

  /**
   * One observation of the instrument — every `STATUS?` the session takes comes through here, and
   * every edge the follower acts on is computed from the difference between this one and the last.
   * There are no timers.
   */
  observe(status: CfxStatus | null, connection: ConnectionState): void {
    if (connection !== "connected") {
      // A disconnect ends the *listing's* identity: the next connection re-establishes a baseline
      // rather than diffing against a folder it hasn't looked at in the meantime, and asks again
      // which file the folder's run belongs to rather than trusting an answer from before the cable
      // went — a whole different run may have been started and finished in the meantime.
      //
      // What it deliberately does not end is what this session knows about the run itself:
      // `watchedRuns` and `acknowledged` are page-session facts, not connection facts (see
      // {@link RunFollowerMemory.watchedRuns}). Reconnecting to a run that finished in the meantime
      // then takes the ordinary path — the first listing sees a folder still in progress and pulls
      // it, and the finished-run rule acknowledges it, collecting the last read exactly as it would
      // have live.
      this.#m.lastNames = null;
      this.#m.baselineAsked = false;
      this.#m.lastStep = null;
      this.#m.wasRunning = false;
      this.#m.activateNext = false;
      this.#m.identified = false;
      // The offer belongs to a connection: it describes what is in the instrument's folder right
      // now, and with the cable out there is nothing to download it from.
      this.#set({ available: null });
      return;
    }
    if (!this.#ui.watching) return;

    // --- the finished run (§7.6) ---------------------------------------------------------------
    // Read first, because a finish *is* a step transition out of the last `PLATEREAD` and the two
    // rules must not both claim it — see below.
    if (status) this.#observeRun(status);

    // --- the step-transition rule (§7.5) -------------------------------------------------------
    const previousStep = this.#m.lastStep;
    const step = status?.stepText ?? null;
    this.#m.lastStep = step;
    // The completed file appears as the plate read *ends*, so this fires on the way out of one.
    //
    // Never while a finish is being collected. The **last** read is the one case where the file
    // does not appear when the step ends: it lands only when §7.6's acknowledgement releases the
    // run, which the finish sequence owns. An edge listing racing that acknowledgement sees the
    // run's last files and pulls them as an ordinary cycle — and the finish, finding the listing
    // unchanged, then reads that as "this run wrote no folder" and collects a report instead. The
    // run's completing pass, its `REFETCH_AT_END` re-read and its traffic log go with it.
    if (!this.#m.finishing && isPlateRead(previousStep) && previousStep !== step) {
      void this.#check("edge");
    }

    // --- the baseline listing on connect -------------------------------------------------------
    //
    // `#check`'s first-listing case pulls immediately if the folder is already mid-run, and
    // otherwise just records what it holds as a baseline to diff later listings against. Either
    // way it takes one listing, so it happens once per connection rather than waiting on whichever
    // of the edges above happens to fire first.
    if (!this.#m.baselineAsked) {
      this.#m.baselineAsked = true;
      void this.#check("baseline");
    }
  }

  /**
   * The §7.6 rule: a completed protocol leaves `STATUS?` reporting IDLE with the run's name still
   * attached — the instrument is *holding* the finished run. Acknowledging it is what releases
   * that and makes the final plate read, the `ended` marker and the `.alf` report appear, so
   * without this the run would sit in the file bar permanently flagged in-progress, missing its
   * last cycle.
   *
   * `CfxSession.acknowledgeFinishedRun` re-checks the status itself before sending anything,
   * because the same command aborts a run that is still going. Guarded twice more here: once
   * ({@link RunFollowerMemory.acknowledged}) so a repeat observation can't send it twice for one
   * run, and once ({@link RunFollowerMemory.watchedRuns}) so this only ever applies to a run this
   * session watched running.
   */
  #observeRun(status: CfxStatus): void {
    // Anything but §7.6's finished-run-still-held (`isFinishedRun`) is the bookkeeping case: a run
    // going, or nothing there at all.
    if (!isFinishedRun(status)) {
      // A new run clears the latch, so the next finish is acknowledged too. No listing here: the
      // step-transition rule's first plate read (or the baseline pull, for a run found already
      // going) is what actually surfaces it — see the module comment.
      if (status.running) {
        this.#m.acknowledged = null;
        if (status.runName) this.#m.watchedRuns.add(status.runName);
        if (!this.#m.wasRunning) {
          this.#m.activateNext = true;
          this.#set({ finished: null }); // a new run starting retires the previous one's banner
        }
        this.#m.wasRunning = true;
        this.#m.lastElapsed = status.elapsedS;
      } else {
        this.#m.wasRunning = false;
      }
      return;
    }
    this.#m.wasRunning = false;
    if (!this.#m.watchedRuns.has(status.runName)) return;
    if (this.#m.acknowledged === status.runName) return;
    this.#m.acknowledged = status.runName;
    const finishedName = status.runName;
    const totalS = this.#m.lastElapsed;
    // Consumed here: it described *this* run, and the next one gets to say for itself.
    const expectReport = this.#m.reportOnly;
    this.#m.reportOnly = false;
    this.#m.finishing = true;
    void this.#finish(finishedName, totalS ?? 0, expectReport);
  }

  async #finish(runName: string, totalS: number, expectReport: boolean): Promise<void> {
    try {
      await this.#finishNow(runName, totalS, expectReport);
    } finally {
      this.#m.finishing = false;
    }
  }

  async #finishNow(runName: string, totalS: number, expectReport: boolean): Promise<void> {
    this.#set({
      note: expectReport
        ? `Run "${runName}" finished — collecting its report.`
        : `Run "${runName}" finished — collecting the last read.`,
    });
    // Sent either way: the acknowledgement is what releases the instrument from holding the
    // finished run, and a thermal-only run is held exactly as a qPCR one is.
    await this.#session.acknowledgeFinishedRun();
    // Forced: the final read and `ended` land as part of this same moment, and waiting for the
    // signature to differ would just add a round trip. This is also the run's last `.zpcr`, so the
    // USB traffic log is attached here, if "save log" asks for one.
    //
    // Skipped outright when the run was known in advance to write no folder — there is nothing to
    // list for. Otherwise the listing itself answers it: `#check` declines a stale folder and says
    // so through `staleAtFinish`, which is what catches a thermal-only run started at the
    // instrument's own touchscreen.
    const id = expectReport ? null : await this.#check("final");
    if (id) {
      this.#set({ finished: { name: runName, totalS, fileName: id } });
      // `PCRunReport` now holds the report *this* run wrote, and a last-run panel has been showing
      // the previous run's until this moment. Last, and awaited, so it takes the command channel
      // after the run's own files rather than alongside them. The other branch needs no such call:
      // collecting the report reads the same directory, which is the same read.
      await this.#session.refreshLastReport();
      return;
    }
    if (!expectReport && !this.#m.staleAtFinish) return; // a failed pass, retried by the next edge
    const reportId = await this.#collectReport(runName);
    if (reportId) this.#set({ finished: { name: runName, totalS, fileName: reportId } });
  }

  /**
   * Fetch the finished run's `.alf` report and put it in the file bar, selected.
   *
   * What a thermal-only run produces instead of a `.zpcr` — the instrument writes one report per
   * run to `\Storage Card\PCRunReport` and clears that directory at the start of every run
   * (`usb.md` §7.1/§7.10), so the report waiting there afterwards is this run's. It is a real file
   * of the user's from that point on: an ordinary entry in the bar, in the catalog and in
   * IndexedDB, which they can read, keep or delete like any other.
   *
   * Selected on arrival for the same reason a run this session watched start is: it is the thing
   * that just came into existence because they pressed Start, and it is the only record that the
   * run happened at all.
   */
  async #collectReport(runName: string): Promise<string | null> {
    const report = await this.#session.fetchRunReport();
    if (!report) {
      this.#set({ note: `Run "${runName}" finished, and left no report on the instrument.` });
      return null;
    }
    const id = await this.#ports.onReport(report.name, report.bytes);
    this.#set({
      note: id
        ? `Run "${runName}" finished — its report is in the file bar.`
        : `Run "${runName}" finished, but its report could not be opened.`,
    });
    return id;
  }

  // --- listing and pulling ---------------------------------------------------------------------

  /**
   * List the run folder, and pull it if this {@link CheckReason} says to — **one at a time**.
   *
   * A pull is slow (many sequential commands) and two can be asked for at once: the last plate
   * read's `PLATEREAD` → `IDLE` edge and the §7.6 finish land in the same moment by construction.
   * This used to drop the second one, and dropping it lost the run's completing pass — the
   * `REFETCH_AT_END` re-read and the USB traffic log with it, since whichever check won was the
   * `edge` one, which attaches neither. Queueing instead costs one extra listing in the rare case
   * and cannot lose the `final`.
   */
  async #check(reason: CheckReason): Promise<string | null> {
    const run = this.#queue.then(
      () => this.#checkNow(reason),
      () => this.#checkNow(reason),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #checkNow(reason: CheckReason): Promise<string | null> {
    this.#m.pulling = true;
    try {
      const dir = await this.#session.refreshRunFolder();
      if (!dir?.listed) return null;
      const previous = this.#m.lastNames;
      const first = previous === null;
      const changed = first || signatureOf(previous) !== signatureOf(dir.names);
      // A name that was there and has *gone* means the instrument cleared the folder for a
      // different run, so the file we have been writing to is not this run's. Asking again costs
      // one small read (`#pull`'s identity fetch), and it is what stops a run started while we
      // watched — same folder, and possibly the same derived name — from being appended to the
      // previous run's file.
      if (previous) {
        const present = new Set(dir.names);
        if (previous.some((n) => !present.has(n))) this.#m.identified = false;
      }
      this.#m.lastNames = dir.names;
      // See the module comment: the folder usually holds the last run when we arrive, but not
      // always — a reload mid-run, or a connect that happens after the run had already started,
      // presents a first listing that is itself in progress. Don't make that wait for a change.
      if (first && (reason === "baseline" || reason === "edge")) {
        if (runProgressFromNames(dir.names).inProgress) {
          this.#set({ note: "Found a run already in progress — pulling its current state." });
          return await this.#pull(dir.names, false);
        }
        this.#set({ note: "Watching for changes to the current run." });
        // Not pulling it doesn't mean not mentioning it: if this is a run the app doesn't have,
        // that is worth saying, with a button (see `RunFollowerState.available`).
        await this.#checkAvailable(dir.names);
        return null;
      }
      // **The end-of-run pass is the one place a stale folder gets mistaken for a run.** It is
      // forced, so it would otherwise pull whatever is in `CurrentRun` whether or not this run put
      // it there — and a thermal-only run puts nothing there at all, leaving the *previous* run's
      // complete folder sitting where the pull would find it. That is how a 45-cycle qPCR run once
      // came back as the archive of a reverse-transcription incubation.
      //
      // A real run's finish always changes the listing: the last plate read, the `ended` marker and
      // the `.alf` all land in the moment §7.6's acknowledgement releases them. So an unchanged
      // listing here is proof the folder is not this run's, and the finish collects the run's own
      // report instead (see `staleAtFinish`).
      //
      // `download` is exempt: the user named the run on the instrument, so an unchanged listing is
      // simply the folder they pointed at.
      if (reason === "final" && !changed) {
        this.#m.staleAtFinish = true;
        this.#set({ note: "This run wrote no run folder — collecting its report instead." });
        return null;
      }
      this.#m.staleAtFinish = false;
      const final = reason === "final" || reason === "download";
      if (changed || final) return await this.#pull(dir.names, final);
      return null;
    } finally {
      this.#m.pulling = false;
    }
  }

  /**
   * Is the run in the folder one this browser is holding? Sets {@link RunFollowerState.available}
   * to what it would download if not.
   *
   * The same identity read a pass does, for the case where there will be no pass: a folder holding
   * a run that is over is left alone, so without this the app would know a run is there — the rail
   * says `finished`, with a plate-read count — and never say whose it is or that it could be had.
   * Answering costs ~8 KB and one round trip, once per connection.
   */
  async #checkAvailable(names: readonly string[]): Promise<void> {
    const idNames = runIdentityFileNames(names);
    if (idNames.length === 0) {
      this.#set({ available: null }); // not a run folder at all — nothing to offer
      return;
    }
    const files = await this.#session.fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, idNames);
    if (!files) return; // a failed read leaves the last answer standing; the rail reports it
    const progress = runProgressFromNames(names);
    const name = zpcrNameFromRunFiles(files, this.#naming());
    const candidate = this.#ports.heldRun(name);
    if (isSameRun(candidate?.files, files)) {
      this.#set({ available: null }); // already in the bar, run and all — nothing to offer
      return;
    }
    this.#set({
      available: {
        name,
        plateReads: progress.plateReads,
        inProgress: progress.inProgress,
        // The same adoption `#pull` makes, so the offer says where the click will actually put the
        // run rather than implying a file the user hasn't got.
        into: candidate && !hasRunIdentity(candidate.files) ? candidate.id : null,
      },
    });
  }

  #naming(): RunFolderNaming | undefined {
    return this.#ports.naming?.();
  }

  /**
   * Fetch whatever this listing holds that the run's own file doesn't, and hand it over.
   *
   * `finalAssembly` marks a pass that completes a run — the end-of-run one, and a download of a
   * run that is already over — and does two things: it re-reads the {@link REFETCH_AT_END} files,
   * whose copies in the file are as old as the moment they first arrived, and it adds the session's
   * USB traffic log as an extra entry when the "save log" switch asks for one
   * (`CfxSession.trafficLogForRun` decides). Both belong to a completing pass only — every
   * intermediate `.zpcr` a run produces stays exactly what's on the instrument, and the log is a
   * one-time addition once there's nothing left to supersede it. Reading the switch *here*, at the
   * end, is also what lets someone turn it on mid-run and still get the whole run: the recording
   * was running the entire time either way.
   */
  async #pull(names: readonly string[], finalAssembly: boolean): Promise<string | null> {
    // **What the run's file already holds is the record of what has been downloaded.** Every pass
    // reads it back rather than consulting anything kept here, so the answer is always the truth
    // about the file the user actually has: delete it and the next pass fetches the run from the
    // top, keep it and only what the instrument has newly written is fetched.
    let file = this.#m.identified ? this.#ui.fileName : null;
    let held = file ? this.#ports.heldRun(file) : null;
    // Where a *whole* pass should land, when it isn't simply a new file: the pending experiment
    // this run was started from, found under the run's own name but holding nothing of the run
    // yet. Null the rest of the time, and never consulted when there is a `held` run to update.
    let adoptId: string | null = null;
    let identity: ZpcrArchive = {};
    if (!held) {
      // We don't know which file this folder's run belongs to — a fresh connection, a folder the
      // instrument has cleared for a different run, or a file that has gone. Read the two entries
      // that *name* a run (~8 KB of ~400 KB) and let them point at it: the file they name, if we
      // hold that same run, and otherwise nothing, which is a full download.
      const idNames = runIdentityFileNames(names);
      if (idNames.length > 0) {
        const fetched = await this.#session.fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, idNames);
        if (!fetched) return null; // the fetch failed; the rail reports it, and we retry next tick
        identity = fetched;
        file = zpcrNameFromRunFiles(fetched, this.#naming());
        const candidate = this.#ports.heldRun(file);
        // A file of the right name is not necessarily the right run: the instrument clears the
        // folder when a run starts, so `RunInfo.xml` has to agree before we append to it.
        held = isSameRun(candidate?.files, fetched) ? candidate : null;
        // A candidate that can't agree because it has no `RunInfo.xml` at all is a different case,
        // and the common one for a run started from a shared folder: a run in progress buffers to
        // IndexedDB and is only written back to disk when it ends, so the copy this browser opened
        // mid-run is still the pre-run experiment the run was started from. There is nothing there
        // to merge into — the pass stays whole — but it is that file the run belongs in, rather
        // than a second one beside it. A candidate whose `RunInfo.xml` merely *differs* is somebody
        // else's run and is left alone.
        if (!held && candidate && !hasRunIdentity(candidate.files)) adoptId = candidate.id;
        this.#m.identified = true;
      }
    }
    const wanted = runFilesToFetch(held?.files ?? null, names, finalAssembly ? REFETCH_AT_END : undefined);
    const fetched: ZpcrArchive = {};
    const missing = wanted.filter((n) => identity[n] === undefined);
    if (missing.length > 0) {
      const got = await this.#session.fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, missing);
      if (!got) return null; // as above — a failed fetch is retried, not reported as a bad run
      Object.assign(fetched, got);
    }
    for (const name of wanted) {
      const already = identity[name];
      if (already) fetched[name] = already;
    }
    const files: ZpcrArchive = { ...held?.files, ...fetched };
    if (finalAssembly) {
      const log = this.#session.trafficLogForRun();
      if (log) {
        files[USB_TRAFFIC_LOG_NAME] = log;
        fetched[USB_TRAFFIC_LOG_NAME] = log;
      }
    }
    const activate = this.#m.activateNext;
    this.#m.activateNext = false;
    try {
      // Handed over as the archive it already is, not as zipped bytes: the store keeps a run in
      // progress open and appends to it, so a cycle costs the one plate read that arrived and no
      // ZIP work at either end.
      //
      // The folder as a whole — what the file holds plus what this pass fetched — is what names the
      // run (`zpcrNameForRunFolder`) and what proves it is one; what goes *to the store* is only
      // what this pass fetched, unless there is nothing there to lay it over.
      const runName = zpcrNameForRunFolder(files, this.#naming());
      // A pass is whole when there is no file of ours to update: a run this browser doesn't have,
      // or one whose file has just been renamed out from under us — the name is re-derived here
      // from the folder's own `RunInfo.xml`, which the end-of-run pass re-reads, so it can move
      // mid-run. An update is only a run when laid over the rest of one; where that is missing,
      // everything we have goes over instead, including whatever the user had added to the file it
      // came from.
      //
      // A rename is the one case a held run still goes over whole, and it goes under the *new*
      // name — that is the point of it — so it is kept apart from `whole` here. The comparison is
      // against the held file's *base* name, since the id it is filed under may be a path into a
      // granted folder while the run only ever names itself bare: a run has not been renamed merely
      // by being kept in a shared folder.
      const renamed = held !== null && runName !== baseNameOf(held.id);
      const whole = held === null || renamed;
      const update = whole ? files : fetched;
      // Handed over under the id the run was **found** under rather than the name it derives for
      // itself: the two differ for a file opened out of a granted folder (a path, not a bare name),
      // and the id is the one the store can merge into. Failing that, the pending experiment this
      // run was started from (`adoptId`), and failing that the derived name — a run this browser
      // has nothing of yet, which is a new file.
      const id = await this.#ports.onRun(
        { name: renamed ? runName : (held?.id ?? adoptId ?? runName), archive: update, whole },
        this.#ui.fileName,
        activate,
      );
      const reads = runProgressFromNames(names).plateReads;
      this.#set({
        fileName: id,
        // Whatever was on offer is now in the file bar — this pass is what installed it.
        ...(id ? { available: null } : {}),
        note: `Updated at ${new Date().toLocaleTimeString()} — ${reads} plate reads`,
      });
      return id;
    } catch (e) {
      // An incomplete folder (no RunInfo.xml yet, in the seconds after a run starts) throws here.
      // That's a "not yet", not a failure — the next check will find it.
      this.#set({ note: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }
}
