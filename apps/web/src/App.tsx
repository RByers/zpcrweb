import { useCallback, useMemo, useRef, useState } from "react";
import {
  plateToCsv,
  ProtocolBuilder,
  runFileBaseName,
  runProgressFromNames,
  type ZpcrArchive,
  type RunPlan,
  type Zpcr,
} from "@zpcrweb/core";
import { fileBytes, useZpcrStore } from "./state/useZpcrStore";
import { useCfxDevice } from "./state/useCfxDevice";
import { useRunWatch } from "./state/useRunWatch";
import { usePltdPassword } from "./state/pltdPassword";
import { formatLoadHash } from "./state/urlHash";
import { cloneFileName, splitFileName } from "./lib/cloneName";
import { isPendingExperiment } from "./lib/experiment";
import { plateSources, protocolSources } from "./lib/attachSources";
import { plateCsvFileName } from "./lib/plateNames";
import { downloadBytes } from "./lib/download";
import { useHeaderFit } from "./state/useHeaderFit";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
import { FilesTableView } from "./components/FilesTableView";
import { ViewBar } from "./components/ViewBar";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { OverviewView } from "./components/views/OverviewView";
import { CurvesView } from "./components/views/CurvesView";
import { CalibrationView } from "./components/views/CalibrationView";
import { ReferenceView } from "./components/views/ReferenceView";
import { PlatesView } from "./components/views/PlatesView";
import { RawFilesView } from "./components/views/RawFilesView";
import { PcrdRawView } from "./components/views/PcrdRawView";
import { StandalonePlateView } from "./components/views/StandalonePlateView";
import { StandalonePlateOverviewView } from "./components/views/StandalonePlateOverviewView";
import { StandaloneRawView } from "./components/views/StandaloneRawView";
import { StandaloneProtocolOverview } from "./components/views/StandaloneProtocolOverview";
import { ProtocolView } from "./components/views/ProtocolView";
import { AboutView } from "./components/views/AboutView";
import { InstrumentView } from "./components/views/InstrumentView";
import type { ViewId } from "./state/useZpcrStore";

/**
 * The **view bar** is the app's tab strip (`components/ViewBar.tsx`); the **file bar** is the row
 * of chips under it (`components/FileBar.tsx`). Everything in the view bar except its Files tab is
 * a lens on the one file the file bar has selected, and this module is where that correspondence
 * is enforced: {@link enabledViewsFor} answers "which tabs does *this* file support", and an empty
 * answer — no selection, or a run that hasn't decoded — greys the whole group out.
 */
const STANDALONE_VIEWS = ["overview", "plates", "raw"] as const;
/** A Biomeme run has no reference row and no `.Dcal` calibration files, so those two tabs are
 * disabled. Raw stays: the run *is* one JSON document, so there is no archive to browse
 * (`Zpcr.archive` is honestly empty) but there is very much a file to read — rendered by the
 * same {@link StandaloneRawView} a `.plt.csv` gets, for the same reason (one text file, no
 * container around it). */
const BIOMEME_VIEWS = ["overview", "protocol", "curves", "plates", "raw"] as const;
/** A `.prcl.txt` is a document to read and edit (Protocol, the annotated directive listing of
 * `protocol.md`) and a file to inspect verbatim (Raw — it's plain text, so this is the same view a
 * `.plt.csv` gets). Overview stays minimal — just the filename, per
 * {@link StandaloneProtocolOverview} — since Protocol is where the content actually lives. It has
 * no curves and no plate, and no longer lists Instrument: a protocol file is not something that
 * can be started, only attached to an experiment that can (see {@link InstrumentView}). */
const PROTOCOL_VIEWS = ["overview", "protocol", "raw"] as const;

/** A `.pltd`/`.plt.csv` uploaded on its own, rather than a run — only these three tabs apply. */
const isStandaloneKind = (kind: string) => kind === "pltd" || kind === "csv";

/**
 * The views that are not lenses on the selected file, and so survive a selection that supports
 * nothing — including no selection at all. Files is the catalog, About is the app itself, and
 * Instrument is a machine on the other end of a cable (see `ViewBar`); none of the three has a
 * reason to be swapped out from under the user because a chip changed.
 */
const FILE_INDEPENDENT_VIEWS = new Set<ViewId>(["files", "about", "instrument"]);

/**
 * The view-bar tabs a given file supports. The tabs it leaves out are still drawn — greyed out,
 * see `ViewBar` — so this decides what is *enabled*, not what exists.
 *
 * An **empty** result means "no tab applies": a run that hasn't decoded (behind the password
 * prompt, or failed), which has nothing to show anywhere. The caller uses the same empty answer
 * for "nothing is selected", since the two produce the same strip.
 */
function enabledViewsFor(kind: string, zpcr?: Zpcr | null): readonly ViewId[] {
  if (isStandaloneKind(kind)) return STANDALONE_VIEWS;
  if (kind === "biomeme") return BIOMEME_VIEWS;
  if (kind === "prcl") return PROTOCOL_VIEWS;
  if (!zpcr) return [];
  // Instrument isn't here: it is not a lens on this file, or on any file (see `ViewBar`). Which
  // experiment it would *start* is asked in the view itself — `instrumentExperiment` below.
  return runViews(zpcr);
}

/**
 * The tabs a run supports, from what it actually holds rather than from what kind of file it is.
 *
 * A finished run holds everything and this returns the full set — but a run *in progress* does
 * not, and the extreme case is a pending experiment (`lib/experiment.ts`): a protocol at most, and
 * often not even that. Curves with no plate read, Reference with no readings to compare against
 * `FactoryRefRowCal`, and Calibration with no calibration set each render an empty frame that reads
 * as a broken view rather than an absent one — so each is greyed out with the same "not available
 * for this file" the other kinds already get, and comes back on its own as the instrument produces
 * the data, since every snapshot re-parses.
 *
 * Protocol is the one tab a pending experiment always gets even with nothing in it, because there
 * it is the *editor* rather than a record — that is where a from-scratch experiment's protocol comes
 * from (see `ProtocolView`). Plates, by contrast, needs a plate to show, and attaching one is an
 * Overview affordance while the experiment is pending.
 */
function runViews(zpcr: Zpcr): readonly ViewId[] {
  const views: ViewId[] = ["overview", "protocol"];
  const read = zpcr.reads.length > 0;
  if (read) views.push("curves");
  if (read || zpcr.plates().length > 0) views.push("plates");
  // Reference plots the reference row's own readings against the factory calibration, and
  // Calibration separates this run's channels through the calibration set: both need readings
  // *and* the thing they are read against. Asked of the decoded run rather than of its archive
  // entries, since a `.pcrd` carries the same calibrations with no archive at all (see "Format
  // independence") — `calibrations()` decodes them, which is why the caller memoizes this.
  if (read && zpcr.factoryRefCal().length > 0) views.push("reference");
  if (read && zpcr.calibrations().length > 0) views.push("calibration");
  views.push("raw");
  return views;
}

/**
 * The run offered on the welcome screen, served from `public/examples/` (a symlink to the
 * repo's `samples/`, so there's one copy of the file). Relative to the page, so it works on a
 * dev server, on a subpath deploy, and offline-cached alike.
 */
const EXAMPLE_FILE = "examples/20260726_S183-S185_RVP.zpcr";

/** The wordmark, doubling as the link to the About page. Split so a narrow header can drop the
 * "//web" tail (see `.app__logo-rest` in `app.css` and `useHeaderFit`) and keep "zpcr" — the
 * full mark plus the eight view tabs plus the load button don't fit across a phone in portrait. */
function Logo({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="app__logo mono"
      onClick={onClick}
      title="About zpcrweb"
      aria-label="About zpcrweb"
    >
      <span className="app__logo-z">z</span>
      pcr
      <span className="app__logo-rest">//web</span>
    </button>
  );
}

export function App() {
  const store = useZpcrStore();
  const { active, activeRun, settings } = store;
  // Called before the early returns below, as hook order demands. The only dep is the selected
  // tab: the strip is the same tabs for every file (they disable rather than disappear), so the
  // header's natural width changes only with which label level 2 keeps — or with a resize, which
  // the hook's own `ResizeObserver` catches.
  const { ref: headerRef, fit } = useHeaderFit([store.view]);
  const [pltdPassword, setPassword] = usePltdPassword();
  /**
   * The instrument connection, held here rather than inside the Instrument view.
   *
   * It used to live in that view, which meant leaving the view closed the USB interface — fine
   * when the view was the only thing that talked to the instrument, and wrong now that a started
   * run has to keep being followed while you sit in Curves watching its amplification curves come
   * in. The connection is a property of the session, not of a tab.
   */
  const instrument = useCfxDevice();
  /**
   * Keep a `.zpcr` of the run in progress up to date in the file list.
   *
   * Activating the refreshed copy only when the user was already on it: following unconditionally
   * would yank the view back to the running experiment every cycle. Following it when they *are*
   * on it is the whole point — that is what makes the Curves view grow a cycle at a time.
   *
   * The watcher's own `activate` overrides that, for the two files someone just caused to exist:
   * a run that began during this session, and a run they clicked Download run for. Neither has a
   * previous view of *this* run to preserve, and both are what the person who acted wants on
   * screen (see `useRunWatch`'s `onRun`).
   */
  /**
   * The names of the experiment this session started, pinned at the click on Start.
   *
   * The run watcher names each snapshot it pulls from these (`core/runFolder.ts`'s naming
   * precedence), which is what makes the snapshots *supersede* the experiment's own file rather than
   * landing beside it. Pinned rather than read live off the active file for the same reason it
   * always was: the selection can move while a run cycles, and the run being assembled has to keep
   * the name it was started under. It is far less machinery than the phase/lock state this replaced
   * (`useRunNaming`, removed), because there is no longer a *typed* name to protect — the name is a
   * property of the file before the instrument is ever involved, so all that is left to remember is
   * which file was started.
   */
  const [startedRun, setStartedRun] = useState<{ experimentName: string; fileName: string } | null>(
    null,
  );
  /**
   * Which experiment the Instrument view is pointed at, when the user has said so.
   *
   * Null means "no choice made", and {@link instrumentTargetName} then falls back to the selected
   * file. Holding a *name* rather than the resolved file keeps this honest across a reload of the
   * file's content and across the run watcher rewriting a run under the same name once a cycle.
   */
  const [instrumentTarget, setInstrumentTarget] = useState<string | null>(null);
  const runWatch = useRunWatch(
    instrument,
    useCallback(
      async (
        run: { name: string; archive: ZpcrArchive; whole: boolean },
        previousId: string | null,
        activate: boolean,
      ) => {
        const wasWatchingIt = store.activeName !== null && store.activeName === previousId;
        return store.addRunArchive(run.name, run.archive, {
          activate: wasWatchingIt || activate,
          modified: true,
          // What the instrument just wrote, laid over the run's file — not the run re-assembled.
          merge: !run.whole,
        });
      },
      [store],
    ),
    // What the app is holding for a run — the watcher's only record of what it has already
    // downloaded, so that the file the user has and the bytes the watcher believes in are the same
    // thing (see `useRunWatch`'s `heldRun`). A file that isn't loaded reads as nothing held.
    useCallback(
      (fileName: string) => {
        const file = store.loaded.find((f) => f.name === fileName);
        return file && file.content.archive ? file.content.files : null;
      },
      [store.loaded],
    ),
    startedRun ?? undefined,
  );
  // Where "← back" on the About page (and the Files table's own ✕) return to, so opening either
  // and leaving again is a no-op.
  const lastView = useRef<ViewId>("curves");
  if (store.view !== "about" && store.view !== "files") lastView.current = store.view;
  const showAbout = () => store.setView("about");
  const leaveAbout = () => store.setView(lastView.current);
  const leaveFiles = () => store.setView(lastView.current);

  // The example goes through the `#load=` hash key rather than calling `addUrl` directly, so
  // the in-app affordance and an external deep link are the same code path. `AboutView` renders
  // it as a real <a href={exampleHref}> — not a button — so the browser's own affordances work
  // on it: "Copy link address", middle-click, a visible target in the status bar. Navigating to
  // it is all it takes; `loadExample` covers only the case where the hash *already* is that
  // value (a repeat click after a failed fetch), which fires no `hashchange`, so nothing would
  // otherwise happen.
  // A run assembled off the instrument is an ordinary added file, so it takes the same
  // `addFiles` path as a drop — and then leaves the Instrument view for it, since staying on a
  // view that shows no file would make a successful open look like nothing happened. Only on success:
  // a rejected archive leaves you where you are, with the error banner.
  const openRun = async (name: string, archive: ZpcrArchive) => {
    if (await store.addRunArchive(name, archive, { modified: true })) store.setView("overview");
  };

  /**
   * The file whose Overview should open with its "Filename" row already in edit mode — set by
   * {@link cloneActiveFile}, cleared by the panel once it has acted on it.
   *
   * Held by id rather than as a bare flag because the clone is added asynchronously: by the time
   * the new file is active and its Overview renders, this is what says "*that* one was just made,
   * so name it" — and a file the user selects some other way in the meantime doesn't inherit the
   * request.
   */
  const [editNameFor, setEditNameFor] = useState<string | null>(null);
  const clearEditName = useCallback(() => setEditNameFor(null), []);

  /**
   * The experiment whose Overview should open with its *name* field focused — the counterpart to
   * {@link editNameFor}, which focuses the **file name** row instead.
   *
   * Two different fields, and which one a new file wants depends on what kind of new file it is. A
   * cloned `.prcl.txt` or plate is a file you rename; a new experiment is a thing you *name*, and
   * its file name follows from that automatically (see `nameExperiment`). Held by id, for the same
   * reason `editNameFor` is: the file is added asynchronously, and a file selected some other way in
   * the meantime must not inherit the request.
   */
  const [nameExperimentFor, setNameExperimentFor] = useState<string | null>(null);
  const clearNameExperiment = useCallback(() => setNameExperimentFor(null), []);

  /** The same signal for a just-created *protocol*, whose name the Protocol tab asks for — see
   * {@link createProtocolFor}. Separate from {@link nameExperimentFor} because the two are different
   * fields on different tabs, and a file can be waiting on either. */
  const [nameProtocolFor, setNameProtocolFor] = useState<string | null>(null);
  const clearNameProtocol = useCallback(() => setNameProtocolFor(null), []);

  /**
   * Create a pending experiment and go name it — "New experiment" (About) and "Clone experiment"
   * (Overview, Instrument) both land here, differing only in the parts they pass.
   *
   * The file is created *first*, and named second, which is the inversion this whole refactor turns
   * on: an experiment used to come into existence only at the click on Start, from a name typed on
   * the Instrument tab, so until then there was nothing to attach a plate to or write a protocol
   * into. Now there is a file from the outset — with a bare-date name, deliberately not a guess at
   * what the experiment is called — and the Overview it lands on asks for the name.
   */
  const createExperiment = useCallback(
    async (parts: Parameters<typeof store.createExperiment>[0], landOn: ViewId = "overview") => {
      const id = await store.createExperiment(parts);
      if (!id) return null;
      store.setView(landOn);
      setNameExperimentFor(id);
      return id;
    },
    [store],
  );

  /**
   * "Clone experiment": a new pending experiment carrying this run's protocol and plate, and
   * nothing else.
   *
   * Deliberately not a copy of the file (that is `cloneActiveFile`, which every other kind still
   * gets): a run's results are the bulk of what it holds and a second copy of them is never what
   * was wanted — re-running the experiment is. So only the two inputs come across, and the plate
   * comes across as *re-serialized CSV* (`plateToCsv`) rather than the archive's own bytes, which is
   * what lets this work identically for a `.pcrd` or a Biomeme run that has no plate entry to copy.
   */
  const cloneExperiment = useCallback((fileName: string) => {
    // The file to clone is named by the caller, never read from the selection: Overview means the
    // file it is showing, and the Instrument view means the experiment *it* is pointed at, which
    // since that view stopped being a lens on the selection need not be the selected one at all.
    const zpcr = store.runs.get(fileName)?.zpcr;
    if (!zpcr) return;
    const plate = zpcr.plates(pltdPassword || undefined)[0]?.pltd.plate ?? null;
    void createExperiment({
      protocol: zpcr.protocolText
        ? { runDefinition: zpcr.protocolText, name: zpcr.protocol()?.name || undefined }
        : undefined,
      plate: plate
        ? {
            name: plateCsvFileName(plate),
            bytes: new TextEncoder().encode(plateToCsv(plate)),
          }
        : undefined,
    });
  }, [store, pltdPassword, createExperiment]);

  /**
   * Name an experiment, which also names its file.
   *
   * The two are one action here and nowhere else: an experiment arrives called `20260804.zpcr`, and
   * leaving that as the file name while the run is called something else would make the file bar,
   * the download and the instrument's own deposit disagree about which run this is. So the rename
   * follows the convention every run's file uses (`runFileBaseName` — today's date and the name,
   * spaces as underscores) as soon as there is a name to build it from. Only while the file still
   * carries a name this app generated: a file renamed by hand keeps whatever it was called, since
   * that was somebody's decision.
   */
  const nameExperiment = useCallback(
    (id: string, name: string) => {
      store.updateSettings({ experimentName: name });
      const file = store.files.find((f) => f.name === id);
      const trimmed = name.trim();
      if (!file || !trimmed) return;
      // Only the bare-date placeholder `createExperiment` writes, never a name someone chose.
      if (!/^\d{8}$/.test(file.name.replace(/\.zpcr$/i, ""))) return;
      void store.renameFile(id, `${runFileBaseName(trimmed)}.zpcr`);
    },
    [store],
  );

  /**
   * "New protocol" on an experiment's Overview: write the default protocol into the experiment and
   * go straight to editing it.
   *
   * The default is `ProtocolBuilder.empty()` — the three-line header and `END`, no steps — which is
   * where a protocol typed from scratch starts. It goes into the experiment's *own* archive rather
   * than into a separate `.prcl.txt` beside it: this is the "write one for this experiment" path, and
   * a second file to keep in sync would be exactly the thing the attach menu is for when a reusable
   * protocol is what's wanted (a protocol can still be extracted into its own file afterwards, from
   * the Protocol tab's clone button).
   *
   * It is created **unnamed**, and the Protocol tab asks — the same shape as a new experiment
   * arriving unnamed on its Overview. An earlier version asked for the file name up front, in a form
   * inside the attach menu, which put a text field between the click and the protocol for no reason:
   * the name isn't needed to write the first step, and the view it lands on can ask for it in place.
   */
  const createProtocolFor = useCallback(
    (fileName: string) => {
      // `setRunProtocolText` rather than `attachProtocol`: attaching derives the protocol's name from
      // the file it came from, and this one came from no file — it must arrive *unnamed*, which is
      // what the Protocol tab's headline then asks about.
      store.setRunProtocolText(fileName, ProtocolBuilder.empty().toRunDefinition());
      store.setView("protocol");
      setNameProtocolFor(fileName);
    },
    [store],
  );

  /**
   * "Start experiment": mark this experiment's own file begun, then send the run.
   *
   * No file is created here — the experiment already exists, which is what the pending state is for.
   * `beginExperiment` writes the `begun` marker into it (restamping its date to today first, so an
   * experiment cloned last week and run today is filed under today), and the id it hands back may
   * therefore differ from the one we started with. That id is what the watcher adopts, so its first
   * snapshot supersedes this file rather than landing beside it, and the pinned names are what keep
   * every later snapshot on the same file.
   */
  const startExperiment = useCallback(
    async (plan: RunPlan, fileName: string) => {
      // Named by the caller rather than read from the selection: the Instrument view holds its own
      // target now, and the file bar may well be pointed somewhere else entirely.
      const id = fileName;
      if (!id) return;
      const started = await store.beginExperiment(id);
      if (!started) return;
      // Pin the view to the file it just started, under the name `beginExperiment` settled on —
      // the date restamp can have renamed it. Without this the view would fall back to the
      // selection the moment the run stopped being live, and swap the finished run (and its
      // "clone me" offer) for whatever chip happened to be lit.
      setInstrumentTarget(started.name);
      setStartedRun({
        experimentName: plan.name,
        fileName: started.name.replace(/\.zpcr$/i, ""),
      });
      runWatch.adopt(started.name);
    },
    [store, runWatch],
  );

  /**
   * Copy the active file under the next free `name (N).ext` and open the copy, ready to be
   * renamed — the Overview toolbar's Clone button, for every file kind.
   *
   * It goes through `addFiles` like any other new file, so the copy is validated, persisted to
   * IndexedDB and activated by exactly the same path a dropped file takes. The bytes are
   * `exportBytes` rather than the loaded ones, so a run's clone carries the analysis settings
   * currently on screen (and an edited `.prcl.txt` its edits — the store keeps `bytes` current),
   * and it lands `modified`: the copy exists nowhere but the browser until it is saved.
   */
  const cloneActiveFile = useCallback(async () => {
    const file = store.active;
    if (!file) return;
    const bytes = store.exportBytes(file.name) ?? fileBytes(file);
    const names = new Set(store.files.map((f) => f.name));
    const name = cloneFileName(file.name, (candidate) => names.has(candidate));
    const id = await store.addFiles([new File([bytes.slice()], name, { lastModified: Date.now() })], {
      modified: true,
    });
    if (!id) return;
    store.setView("overview");
    setEditNameFor(id);
  }, [store]);

  /**
   * The Overview toolbar's Download button, for every kind: the bytes as they'd be saved
   * (`exportBytes` — a `.zpcr` including its `zpcrweb.json`, an edited `.prcl.txt` including its
   * edits), under the file's own name.
   *
   * Saving the file to disk is also what un-modifies it: the copy leaving the browser is the one
   * carrying the edits, so the chip's delete stops asking twice.
   */
  const downloadActiveFile = useCallback(() => {
    const file = store.active;
    if (!file) return;
    downloadBytes(file.name, store.exportBytes(file.name) ?? fileBytes(file));
    store.markDownloaded(file.name);
  }, [store]);

  /**
   * What a file chip does: the one thing it always meant — *show me this file* — which is the app's
   * primary selection, `activeName`, drawn in the bar's usual cyan. Every kind can hold it: a run, a
   * standalone plate, and (since it has an Overview of its own) a `.prcl.txt`.
   *
   * It used to mean something else on the Instrument view, where the chips split into a primary run
   * plus auxiliary protocol/plate "overrides" staged over it — the machinery a previous refactor
   * removed (`useRunStaging`). One bar, one meaning, everywhere, and **no refusals**: a chip is
   * clickable on every view including Instrument, which is the point of that view no longer being
   * a lens on the selection. It used to lock the selection while a run was live, so that leaving
   * the running file couldn't abandon the tab that was following it, and to snap the selection to
   * the running file on arrival so that the tab had something to show. Neither is needed now that
   * the view holds its own target ({@link instrumentTarget}): a run is followed by `useRunWatch`
   * whatever is selected, and the view shows the run it is driving without moving the app's
   * selection to do it.
   *
   * From About, picking a chip also *leaves* About for Overview. About is file-independent — it
   * survives a selection change (see `view` below) — so without this the click would land on a
   * page that shows nothing about the file just chosen, and look like nothing happened. Overview
   * rather than the file's first enabled tab because every kind has one, and it is the same place
   * every other "here is a file, go look at it" path lands.
   */
  const selectFile = (id: string) => {
    if (!store.files.some((f) => f.name === id)) return;
    store.setActive(id);
    if (store.view === "about") store.setView("overview");
  };

  /**
   * Which tabs the active file supports. Computed once per file rather than per render, and
   * before the early returns below as hook order demands: for a run this asks what the archive
   * actually holds (`runViews`), and answering the calibration half of that decodes the run's
   * calibration set — tens of milliseconds for a `.pcrd`, which is not a thing to repeat on every
   * keystroke elsewhere in the app.
   */
  const activeViews = useMemo(
    () => (active ? enabledViewsFor(active.kind, store.runs.get(active.name)?.zpcr) : []),
    [active, store.runs],
  );

  /**
   * What the attach/replace menus may offer, resolved here rather than in each view: every plate
   * and every protocol this browser is holding, wherever it lives, minus the active file's own
   * (see `lib/attachSources.ts`). Three views show one of these menus and they must all offer the
   * same things, so the list is built once from the store the menus would otherwise each re-derive.
   */
  const plateAttachSources = useMemo(
    () => plateSources(store.loaded, store.runs, active?.name ?? null, pltdPassword || undefined),
    [store.loaded, store.runs, active, pltdPassword],
  );
  const protocolAttachSources = useMemo(
    () => protocolSources(store.loaded, store.runs, active?.name ?? null),
    [store.loaded, store.runs, active],
  );
  /**
   * A row in the full files table: select the file — which **loads** it if it wasn't (see
   * `useZpcrStore`'s `setActive`), and leaves the Files tab since `store.view` changes under it —
   * and land on its own first enabled tab, the same "click a file, go look at it" a bar chip has
   * always done. `view`, when given (the Plate cell's own link), overrides that landing spot
   * instead of guessing at it.
   *
   * A file that isn't loaded yet has no decoded run to ask, so its enabled set isn't known here;
   * Overview is where such a click lands, and the strip fills in as the bytes arrive.
   */
  const selectFromTable = (id: string, view?: ViewId) => {
    const f = store.loaded.find((x) => x.name === id);
    store.setActive(id);
    store.setView(
      view ?? (f ? enabledViewsFor(f.kind, store.runs.get(id)?.zpcr)[0] ?? "overview" : "overview"),
    );
  };

  /** The Instrument view's "Run complete" banner's "Open run" button: jump straight to that run's
   * amplification curves, the same destination `selectFromTable` sends the Curves cell to. */
  const openFinishedRun = useCallback(
    (id: string) => {
      store.setActive(id);
      store.setView("curves");
    },
    [store],
  );

  const exampleHref = `#${formatLoadHash(EXAMPLE_FILE)}`;
  const loadExample = (e: { preventDefault: () => void }) => {
    if (window.location.hash !== exampleHref) return; // let the navigation do the work
    e.preventDefault();
    void store.addUrl(EXAMPLE_FILE);
  };

  /**
   * The file the Instrument view acts on, in three rungs.
   *
   * 1. **A run live on this instrument** wins outright: while the cycler is running a run this
   *    session is following, that run is what the view is *about*, and offering to start something
   *    else while the block is hot would be offering something the instrument would refuse anyway.
   *    This is what the old snap-the-selection effect was for, done without moving the app's
   *    selection — the file bar stays wherever the user left it.
   * 2. **What they picked here**, if it still exists.
   * 3. **The selected file**, when it is a loaded run, so arriving from an experiment's Overview
   *    lands on that experiment with nothing to re-pick. A default, not a lens: the picker in the
   *    view names it, and choosing anything there pins rung 2 over it.
   * 4. **Whatever this resolved to last**, which is what keeps rung 3 a *default* rather than a
   *    lens by the back door: selecting a `.prcl.txt` or a plate while sitting on this view would
   *    otherwise empty the panel, and "I selected a protocol file" is not a statement about which
   *    experiment the instrument should run.
   */
  const lastInstrumentTarget = useRef<string | null>(null);
  const instrumentTargetName = useMemo(() => {
    const running = instrument.connection === "connected" && !!instrument.status?.running;
    if (running && runWatch.fileName && store.runs.has(runWatch.fileName)) return runWatch.fileName;
    if (instrumentTarget && store.runs.has(instrumentTarget)) return instrumentTarget;
    if (active && store.runs.has(active.name)) return active.name;
    const last = lastInstrumentTarget.current;
    return last && store.runs.has(last) ? last : null;
  }, [instrument.connection, instrument.status, runWatch.fileName, instrumentTarget, store.runs, active]);
  // Written during render rather than in an effect: it is a memo of the render above it, not a
  // state change, and an effect would leave one render resolving to null before it caught up.
  lastInstrumentTarget.current = instrumentTargetName;

  /**
   * That file as the Instrument view sees it: an experiment, or null when there is nothing to
   * point at (nothing loaded, or a selection that is a standalone plate or protocol, or a run that
   * hasn't decoded). Computed here because `App` is what knows the loaded runs and their identities.
   */
  const instrumentExperiment = useMemo(() => {
    if (!instrumentTargetName) return null;
    const file = store.loaded.find((f) => f.name === instrumentTargetName);
    const zpcr = store.runs.get(instrumentTargetName)?.zpcr;
    if (!file || !zpcr) return null;
    const identity = store.experiments.get(file.name);
    return {
      fileName: file.name,
      name: identity?.name ?? file.name,
      named: identity?.named ?? false,
      zpcr,
      pending: isPendingExperiment(file.kind, zpcr),
      // Derived from the file's own markers, so it stays true across a reload mid-run and doesn't
      // depend on this app being the one that started it (`runFolder.ts`).
      inProgress: runProgressFromNames(zpcr.archive.entries).inProgress,
    };
  }, [instrumentTargetName, store.loaded, store.runs, store.experiments]);

  /**
   * What the view's experiment picker offers: every loaded `.zpcr`, newest last, as the bar orders
   * them. Only that kind — it is the one the app can carry to an instrument and the one an
   * instrument produces; a `.pcrd` or a Biomeme export is somebody else's finished record. Runs
   * that already have results are listed too rather than filtered out, because the view has
   * something to say about each of them (it offers the clone that is how you run one again), and a
   * picker that silently omitted the file you were looking at would be the more confusing object.
   */
  const instrumentCandidates = useMemo(
    () =>
      store.loaded
        .filter((f) => f.kind === "zpcr")
        .map((f) => ({
          fileName: f.name,
          name: store.experiments.get(f.name)?.name ?? f.name,
          pending: store.pendingIds.has(f.name),
        })),
    [store.loaded, store.experiments, store.pendingIds],
  );

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
  }

  if (store.files.length === 0 && store.view !== "instrument") {
    // Nothing in the browser at all, so About *is* the welcome screen — it carries the drop
    // target. There's no previous view to go back to, hence no `onBack`, and no view bar: with an
    // empty catalog even the Files tab has nothing to list.
    //
    // Except the Instrument tab, which is why this is not simply "no files". A cycler exists
    // whether or not this browser is holding anything, so "connect an instrument" below leads
    // straight there, and the ordinary chrome renders around an empty file bar.
    return (
      <div className="app app--empty">
        <header className="app__brand">
          <Logo onClick={showAbout} />
          <span className="app__tag">Bio-Rad CFX qPCR viewer</span>
        </header>
        <AboutView
          onFiles={store.addFiles}
          exampleHref={exampleHref}
          onLoadExample={loadExample}
          onNewExperiment={() => void createExperiment({})}
        />
        <div className="app__welcomeinstrument">
          {/* Straight to the tab that talks to the instrument, creating nothing. It used to have to
              invent an experiment first, because the tab was a lens on a file and so unreachable
              without one; connecting is now its own act, and the experiment to run is made from
              inside the view if and when there is one to make. */}
          <button className="btn" onClick={() => store.setView("instrument")}>
            Connect an instrument over USB
          </button>
        </div>
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  const isStandalonePlate = !!active && isStandaloneKind(active.kind);
  const isStandaloneProtocol = active?.kind === "prcl";
  const zpcr = isStandalonePlate || isStandaloneProtocol ? null : activeRun?.zpcr ?? null;
  /** The run is here but not open yet: the password prompt, or a decode that failed. */
  const gated = !!active && !zpcr && !isStandalonePlate && !isStandaloneProtocol;
  /**
   * What the view bar enables. Three cases collapse to the same empty answer, because they are
   * the same fact — no tab has a file to be a lens on:
   *
   * - nothing selected (everything released, or a `#file=` this browser can't resolve);
   * - the selected file's bytes still on their way in from IndexedDB;
   * - a run that hasn't decoded — locked behind the password prompt, or failed.
   *
   * The strip itself stays in all three: the prompt is a gate in the content area, not a reason
   * for the app's chrome to change shape, and a strip that vanished made unlocking look like the
   * tabs were something the file had earned.
   */
  const enabledViews: readonly ViewId[] = activeViews;
  // `store.view` is global (not per-file), so switching entries can land on a view this file has
  // no answer for (e.g. "calibration" on a Biomeme run) — fall back to its first enabled tab
  // then. The tab is drawn either way, just disabled, so this is about where the *content* goes.
  // "about", "files" and "instrument" are all file-independent, so they survive regardless.
  const view =
    enabledViews.length > 0 &&
    !FILE_INDEPENDENT_VIEWS.has(store.view) &&
    !enabledViews.includes(store.view)
      ? enabledViews[0]!
      : store.view;

  return (
    <div className="app">
      <header className="app__header" ref={headerRef} data-fit={fit}>
        <Logo onClick={showAbout} />
        <div className="app__views">
          <ViewBar value={view} onChange={store.setView} enabled={enabledViews} />
        </div>
        <div className="app__header-spacer" />
        <DropZone onFiles={store.addFiles} />
      </header>

      <FileBar
        files={store.loaded}
        runs={store.runs}
        plateFiles={store.plateFiles}
        activeName={store.activeName}
        modifiedIds={store.modifiedIds}
        inProgressIds={store.inProgressIds}
        incompleteIds={store.incompleteIds}
        pendingIds={store.pendingIds}
        onSelect={selectFile}
        onUnload={(id) => void store.setLoaded(id, false)}
        experiments={store.experiments}
      />

      <main className="app__main">
        {/* The instrument, and the experiment *it* is pointed at — not a lens on the selected file,
            which is why it branches out here beside Files rather than inside the block below that
            needs one (see `ViewBar`). It renders with nothing selected, and with nothing loaded at
            all: someone with a cycler and no files can connect, watch, and start a run whose file
            they make from here. */}
        {view === "instrument" ? (
          <InstrumentView
            onOpenRun={openRun}
            onOpenFinishedRun={openFinishedRun}
            experiment={instrumentExperiment}
            candidates={instrumentCandidates}
            onPickExperiment={setInstrumentTarget}
            onNewExperiment={() => {
              // Point the view at what it just made: an earlier pick would otherwise still win
              // the second rung of `instrumentTargetName`, and the new experiment would be
              // created, activated in the bar, and yet not be the one on screen here.
              void createExperiment({}, "instrument").then((id) => id && setInstrumentTarget(id));
            }}
            instrument={instrument}
            runWatch={runWatch}
            onStartExperiment={startExperiment}
            onCloneExperiment={cloneExperiment}
          />
        ) : view === "files" ? (
          <FilesTableView
            files={store.files}
            activeName={store.activeName}
            loadedIds={store.loadedIds}
            modifiedIds={store.modifiedIds}
            onSelectFile={selectFromTable}
            onSetLoaded={(id, on) => void store.setLoaded(id, on)}
            onDelete={store.remove}
            onClose={leaveFiles}
          />
        ) : view === "about" ? (
          <AboutView
            onFiles={store.addFiles}
            exampleHref={exampleHref}
            onLoadExample={loadExample}
            onNewExperiment={() => void createExperiment({})}
            onBack={leaveAbout}
          />
        ) : !active || !settings ? (
          // Files exist but none is selected — every file released, or a `#file=` naming one this
          // browser doesn't have. The chrome stays exactly as it is (view bar disabled but for
          // Files, file bar, drop zone, About), because the way out is to pick a file, and this
          // says where from.
          <div className="app__noselection mono">
            {store.activeName && store.loadingIds.has(store.activeName) ? (
              "opening…"
            ) : (
              <>
                <p>No file selected.</p>
                <p>
                  Choose one from the file bar, or open the <strong>Files</strong> tab to see
                  everything this browser is holding.
                </p>
              </>
            )}
          </div>
        ) : isStandalonePlate ? (
          <>
            {view === "overview" && store.activePlateFile && (
              <StandalonePlateOverviewView
                file={active}
                result={store.activePlateFile}
                onRenameFile={(name) => void store.renameFile(active.name, name)}
                onDownload={downloadActiveFile}
                onClone={() => void cloneActiveFile()}
                autoEditName={editNameFor === active.name}
                onAutoEditHandled={clearEditName}
              />
            )}
            {view === "plates" && store.activePlateFile && (
              <StandalonePlateView file={active} result={store.activePlateFile} />
            )}
            {view === "raw" && <StandaloneRawView key={active.name} file={active} />}
          </>
        ) : isStandaloneProtocol ? (
          <>
            {view === "overview" && (
              <StandaloneProtocolOverview
                file={active}
                onRenameFile={(name) => void store.renameFile(active.name, name)}
                onDownload={downloadActiveFile}
                onClone={() => void cloneActiveFile()}
                autoEditName={editNameFor === active.name}
                onAutoEditHandled={clearEditName}
              />
            )}
            {view === "protocol" && store.activeProtocolFile !== null && (
              <ProtocolView
                key={active.name}
                protocolText={store.activeProtocolFile}
                file={active}
                protocolSources={protocolAttachSources}
                addFiles={store.addFiles}
                // A protocol file is always a draft: it is a document you author, with no run behind
                // it that editing it could contradict.
                editable
                onChangeProtocol={(text) => store.setProtocolText(active.name, text)}
                // A standalone protocol has no `ProtocolName.txt` — its name *is* its file name, so
                // the headline edits that, extension preserved.
                name={splitFileName(active.name).base}
                onRenameProtocol={(name) =>
                  void store.renameFile(active.name, `${name}${splitFileName(active.name).ext}`)
                }
                autoFocusName={nameProtocolFor === active.name}
                onAutoFocusHandled={clearNameProtocol}
              />
            )}
            {view === "raw" && <StandaloneRawView key={active.name} file={active} />}
          </>
        ) : !zpcr ? (
          <div className="app__gate">
            {activeRun?.needsPassword && (
              <PasswordPrompt wrong={false} onSubmit={setPassword} />
            )}
            {activeRun?.error && (
              <PasswordPrompt wrong={true} onSubmit={setPassword} />
            )}
          </div>
        ) : (
          <>
            {view === "overview" && (
              <OverviewView
                zpcr={zpcr}
                file={active}
                run={activeRun!}
                settings={settings}
                identity={
                  store.experiments.get(active.name) ?? {
                    name: active.name,
                    named: false,
                    date: null,
                    dateText: "",
                    fileName: active.name,
                  }
                }
                // Naming an experiment also names its file while it still carries the placeholder
                // one it was created under — see `nameExperiment`.
                onRename={(name) => nameExperiment(active.name, name)}
                // Only a `.zpcr` has an archive to write `zpcrweb.json` into; see
                // `analysisPersist.ts`'s `resolve`.
                namePersists={active.kind === "zpcr"}
                pending={isPendingExperiment(active.kind, zpcr)}
                plateSources={plateAttachSources}
                protocolSources={protocolAttachSources}
                onAttachPlate={(file) => void store.attachPlate(active.name, file)}
                onAttachProtocol={(file) => void store.attachProtocol(active.name, file)}
                onCreateProtocol={() => createProtocolFor(active.name)}
                onCloneExperiment={() => cloneExperiment(active.name)}
                onRenameFile={(name) => void store.renameFile(active.name, name)}
                onDownload={downloadActiveFile}
                autoEditName={editNameFor === active.name}
                onAutoEditHandled={clearEditName}
                autoFocusName={nameExperimentFor === active.name}
                onAutoFocusHandled={clearNameExperiment}
              />
            )}
            {view === "protocol" && (
              <ProtocolView
                protocolText={zpcr.protocolText || null}
                steps={zpcr.protocol()?.steps ?? null}
                // One report per archive (`alf.md` §1); the first is the run's own. Only a run that
                // executed has one, which is what the thermal-profile section is about.
                report={zpcr.runReports()[0]?.alf ?? null}
                file={active}
                protocolSources={protocolAttachSources}
                addFiles={store.addFiles}
                editable={isPendingExperiment(active.kind, zpcr)}
                onChangeProtocol={(text) => store.setRunProtocolText(active.name, text)}
                // The same `attachProtocol` the Overview tab's "replace protocol" calls — the view
                // itself only offers it while the experiment is still pending.
                onAttachProtocol={(file) => void store.attachProtocol(active.name, file)}
                name={zpcr.protocol()?.name ?? ""}
                onRenameProtocol={(name) => void store.setRunProtocolName(active.name, name)}
                autoFocusName={nameProtocolFor === active.name}
                onAutoFocusHandled={clearNameProtocol}
              />
            )}
            {view === "curves" && (
              <CurvesView
                zpcr={zpcr}
                settings={settings}
                onChange={store.updateSettings}
              />
            )}
            {view === "calibration" && (
              <CalibrationView
                zpcr={zpcr}
                settings={settings}
                onChange={store.updateSettings}
              />
            )}
            {view === "reference" && (
              <ReferenceView
                zpcr={zpcr}
                settings={settings}
                onChange={store.updateSettings}
              />
            )}
            {view === "plates" && (
              <PlatesView
                key={active.name}
                zpcr={zpcr}
                fileName={active.name}
                attachPlate={store.attachPlate}
                plateSources={plateAttachSources}
                addFiles={store.addFiles}
              />
            )}
            {view === "raw" && active.kind === "pcrd" && (
              <PcrdRawView
                key={active.name}
                zpcr={zpcr}
                documentXml={activeRun?.documentXml ?? ""}
                fileName={active.name}
              />
            )}
            {view === "raw" && active.kind === "zpcr" && (
              <RawFilesView key={active.name} zpcr={zpcr} settings={settings} />
            )}
            {/* A Biomeme run is a single JSON document rather than an archive, which is exactly
                the shape the standalone viewer handles. */}
            {view === "raw" && active.kind === "biomeme" && (
              <StandaloneRawView key={active.name} file={active} />
            )}
          </>
        )}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
