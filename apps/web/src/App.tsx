import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plateToCsv, ProtocolBuilder, runFileBaseName, type RunPlan, type Zpcr } from "@zpcrweb/core";
import { useZpcrStore } from "./state/useZpcrStore";
import { useCfxDevice } from "./state/useCfxDevice";
import { useRunWatch } from "./state/useRunWatch";
import { usePltdPassword } from "./state/pltdPassword";
import { formatLoadHash } from "./state/urlHash";
import { cloneFileName } from "./lib/cloneName";
import { isPendingExperiment } from "./lib/experiment";
import { plateCsvFileName } from "./lib/plateNames";
import { downloadBytes } from "./lib/download";
import { useHeaderFit } from "./state/useHeaderFit";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
import { FilesTableView } from "./components/FilesTableView";
import { ViewSelector } from "./components/ViewSelector";
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
import { StandaloneProtocolView } from "./components/views/StandaloneProtocolView";
import { ProtocolView } from "./components/views/ProtocolView";
import { AboutView } from "./components/views/AboutView";
import { InstrumentView } from "./components/views/InstrumentView";
import type { ViewId } from "./state/useZpcrStore";

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

/** The file-backed tabs a given file kind supports, or `null` for "all of them". The tabs it
 * leaves out are still drawn — greyed out, see `ViewSelector` — so this decides what is *enabled*,
 * not what exists. Shared by the normal render and the Instrument view's early return, which
 * needs the same answer to draw the rest of the tab strip while it is the selected one.
 *
 * Typed as a non-empty tuple so the view fallback below can take `[0]` — a file with no enabled
 * tab at all would leave nowhere to fall back to. */
function enabledViewsFor(kind: string, zpcr?: Zpcr | null): readonly [ViewId, ...ViewId[]] | null {
  if (isStandaloneKind(kind)) return STANDALONE_VIEWS;
  if (kind === "biomeme") return BIOMEME_VIEWS;
  if (kind === "prcl") return PROTOCOL_VIEWS;
  return zpcr ? runViews(zpcr) : null;
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
function runViews(zpcr: Zpcr): readonly [ViewId, ...ViewId[]] {
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
  return views as [ViewId, ...ViewId[]];
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
   * Activating the refreshed copy only when the user was already on it: every snapshot is a new
   * file id (see `AddFilesOptions.activate`), so following unconditionally would yank the view
   * back to the running experiment every cycle. Following it when they *are* on it is the whole
   * point — that is what makes the Curves view grow a cycle at a time.
   *
   * A `freshStart` — the run began during this session, rather than being found already going —
   * always activates regardless: the run the instrument just started is what someone watching it
   * begin wants on screen, and there's no previous view of *this* run to preserve.
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
  const runWatch = useRunWatch(
    instrument,
    useCallback(
      async (file: File, previousId: string | null, freshStart: boolean) => {
        const wasWatchingIt = store.activeId !== null && store.activeId === previousId;
        return store.addFiles([file], { activate: wasWatchingIt || freshStart, modified: true });
      },
      [store],
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
  const openRun = async (file: File) => {
    if (await store.addFiles([file], { modified: true })) store.setView("overview");
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
    async (parts: Parameters<typeof store.createExperiment>[0]) => {
      const id = await store.createExperiment(parts);
      if (!id) return;
      store.setView("overview");
      setNameExperimentFor(id);
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
  const cloneExperiment = useCallback(() => {
    const zpcr = activeRun?.zpcr;
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
  }, [activeRun, pltdPassword, createExperiment]);

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
      const file = store.files.find((f) => f.id === id);
      const trimmed = name.trim();
      if (!file || !trimmed) return;
      // Only the bare-date placeholder `createExperiment` writes, never a name someone chose.
      if (!/^\d{8}$/.test(file.name.replace(/\.zpcr$/i, ""))) return;
      void store.renameFile(id, `${runFileBaseName(trimmed)}.zpcr`);
    },
    [store],
  );

  /**
   * "New protocol…" on an experiment's Overview: create an empty `.prcl.txt` under the name given,
   * and attach it to that experiment.
   *
   * Two files, deliberately. The protocol becomes a file of its own — nameable, downloadable,
   * attachable to a second experiment later — which is the reason to come this way rather than
   * simply typing on the Protocol tab, where the protocol would belong to this one experiment and
   * nothing else. Both end up editable: the copy inside the experiment through the Protocol tab, the
   * standalone file through its own.
   */
  const createProtocolFor = useCallback(
    async (fileId: string, fileName: string) => {
      const text = ProtocolBuilder.empty().toRunDefinition();
      const file = new File([new TextEncoder().encode(text)], fileName, {
        lastModified: Date.now(),
      });
      // `addFiles` would activate the new `.prcl.txt` and switch to its own Overview (see the store's
      // `prcl` landing rule), which would walk away from the experiment being assembled — so it is
      // added without activating, and the experiment stays on screen with its new protocol attached.
      await store.addFiles([file], { activate: false, modified: true });
      await store.attachProtocol(fileId, file);
      // Naming a protocol is only ever the preamble to writing one, so land on the editor — the
      // experiment's own Protocol tab, which is now holding the empty protocol just attached.
      store.setView("protocol");
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
    async (plan: RunPlan) => {
      const id = store.activeId;
      if (!id) return;
      const started = await store.beginExperiment(id);
      if (!started) return;
      setStartedRun({
        experimentName: plan.name,
        fileName: started.name.replace(/\.zpcr$/i, ""),
      });
      runWatch.adopt(started.id);
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
    const bytes = store.exportBytes(file.id) ?? file.bytes;
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
    downloadBytes(file.name, store.exportBytes(file.id) ?? file.bytes);
    store.markDownloaded(file.id);
  }, [store]);

  /**
   * A run happening right now, live on the instrument and connected over USB — as opposed to
   * merely `inProgressIds` (a loaded file missing its `ended` marker), which stays true for an
   * archive nobody is watching any more. Elsewhere this drives the rail's own state; here it's
   * what scopes the Instrument view's selection lock below.
   */
  const runActive = instrument.connection === "connected" && !!instrument.status?.running;
  /**
   * What a file chip does: the one thing it always meant — *show me this file* — which is the app's
   * primary selection, `activeId`, drawn in the bar's usual cyan. Every kind can hold it: a run, a
   * standalone plate, and (since it has an Overview of its own) a `.prcl.txt`.
   *
   * It used to mean something else on the Instrument view, where the chips split into a primary run
   * plus auxiliary protocol/plate "overrides" staged over it — the machinery this refactor removed
   * (`useRunStaging`). One bar, one meaning, everywhere: the Instrument view now simply starts
   * whichever experiment is selected, so selecting one there is the same act as selecting it
   * anywhere else.
   *
   * The one refusal left: a run **live on the instrument** owns the selection while the Instrument
   * view is showing it, because switching away would abandon watching the run in progress from the
   * very tab that is following it. Everywhere else switching is never blocked — reading Curves while
   * a run cycles is the headline use of the connection staying open across tabs (see `instrument`
   * above), and it would defeat that to pin the selection.
   */
  const selectFile = (id: string) => {
    if (store.view === "instrument" && runActive) return;
    if (store.files.some((f) => f.id === id)) store.setActive(id);
  };
  /**
   * Arriving at the Instrument view while a run is live snaps the selection to it, even if the
   * user had been looking at something else — that's the one file this view can usefully show
   * while a run owns the selection (see `selectFile` above). `runWatch.fileId` rather than
   * `store.activeId` because the two can have drifted apart: a snapshot pulled while the user was
   * elsewhere doesn't activate itself (`AddFilesOptions.activate`), so the store's `activeId` may
   * still be a stale one from before they left. Keyed off `store.view` alone, not `runWatch.fileId`
   * too, so a later snapshot of the *same* run doesn't re-snap someone who has moved on.
   */
  useEffect(() => {
    if (store.view !== "instrument" || !runActive || !runWatch.fileId) return;
    if (store.activeId !== runWatch.fileId) store.setActive(runWatch.fileId);
  }, [store.view]);

  /**
   * Which tabs the active file supports. Computed once per file rather than per render, and
   * before the early returns below as hook order demands: for a run this asks what the archive
   * actually holds (`runViews`), and answering the calibration half of that decodes the run's
   * calibration set — tens of milliseconds for a `.pcrd`, which is not a thing to repeat on every
   * keystroke elsewhere in the app.
   */
  const activeViews = useMemo(
    () => (active ? enabledViewsFor(active.kind, store.runs.get(active.id)?.zpcr) : null),
    [active, store.runs],
  );
  // What the bar actually shows: a file taken off it (`FileSettings.visible`) stays loaded and
  // in the full files table (the "Files" tab, `FilesTableView.tsx`), just not here.
  const visibleFiles = useMemo(
    () => store.files.filter((f) => !store.hiddenIds.has(f.id)),
    [store.files, store.hiddenIds],
  );
  /**
   * A row in the full files table: select the file (which also turns its checkbox back on — see
   * `useZpcrStore`'s `setActive`, and leaves the Files tab since `store.view` changes under it),
   * and land on its own first enabled tab, the same "click a file, go look at it" a bar chip has
   * always done. Falls back to "overview" for a file with no restricted set (an ordinary run),
   * since that tab isn't in the tuple for those — see `enabledViewsFor`. `view`, when given (the
   * Plate cell's own link), overrides that landing spot instead of guessing at it.
   */
  const selectFromTable = (id: string, view?: ViewId) => {
    const f = store.files.find((x) => x.id === id);
    store.setActive(id);
    store.setView(view ?? (f ? enabledViewsFor(f.kind, store.runs.get(id)?.zpcr)?.[0] ?? "overview" : "overview"));
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
   * The active file as the Instrument view sees it: an experiment, or null when the active file
   * isn't one (a standalone plate or protocol, a run that hasn't decoded, or nothing loaded).
   *
   * This is the whole of what that view gets — no selection of its own, no staging — and it is
   * computed here because `App` is what knows the active file, its decoded run and its identity.
   */
  const instrumentExperiment = useMemo(() => {
    if (!active || !activeRun?.zpcr) return null;
    const zpcr = activeRun.zpcr;
    const identity = store.experiments.get(active.id);
    return {
      fileId: active.id,
      name: identity?.name ?? active.name,
      named: identity?.named ?? false,
      zpcr,
      pending: isPendingExperiment(active.kind, zpcr),
    };
  }, [active, activeRun, store.experiments]);

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
  }

  // The Instrument view talks to an instrument rather than being a lens on a file, so it renders the
  // same way whether or not anything is loaded — and is reachable from the welcome screen, which is
  // where someone with a cycler and no files yet actually starts. It keeps the file bar, and the bar
  // means exactly what it means everywhere else now (see `selectFile`): the cyan chip is the active
  // file, which is the experiment this view would start.
  if (store.view === "instrument") {
    return (
      <div className={store.files.length > 0 ? "app" : "app app--nofiles"}>
        <header className="app__header" ref={headerRef} data-fit={fit}>
          <Logo onClick={showAbout} />
          <div className="app__views">
            <ViewSelector
              value="instrument"
              onChange={store.setView}
              // With no file loaded no file-backed tab leads anywhere, so they all grey out.
              enabled={active ? activeViews ?? undefined : []}
            />
          </div>
          <div className="app__header-spacer" />
          <DropZone onFiles={store.addFiles} />
        </header>
        {store.files.length > 0 && (
          <FileBar
            files={visibleFiles}
            runs={store.runs}
            plateFiles={store.plateFiles}
            activeId={store.activeId}
            modifiedIds={store.modifiedIds}
            inProgressIds={store.inProgressIds}
            incompleteIds={store.incompleteIds}
            pendingIds={store.pendingIds}
            activeLocked={runActive}
            onSelect={selectFile}
            onHide={(id) => store.setVisible(id, false)}
            experiments={store.experiments}
          />
        )}
        <main className="app__main">
          <InstrumentView
            onOpenRun={openRun}
            onOpenFinishedRun={openFinishedRun}
            experiment={instrumentExperiment}
            instrument={instrument}
            runWatch={runWatch}
            onStartExperiment={startExperiment}
            onCloneExperiment={cloneExperiment}
          />
        </main>
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  if (!active || !settings) {
    // No file yet, so About *is* the welcome screen — it carries the drop target. There's no
    // previous view to go back to, hence no `onBack`.
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
          <button className="btn" onClick={() => store.setView("instrument")}>
            Connect an instrument over USB
          </button>
        </div>
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  const isStandalonePlate = isStandaloneKind(active.kind);
  const isStandaloneProtocol = active.kind === "prcl";
  const zpcr = isStandalonePlate || isStandaloneProtocol ? null : activeRun?.zpcr ?? null;
  /** The run is here but not open yet: the password prompt, or a decode that failed. */
  const gated = !zpcr && !isStandalonePlate && !isStandaloneProtocol;
  const enabledViews = activeViews;
  // `store.view` is global (not per-file), so switching entries can land on a view this file has
  // no answer for (e.g. "calibration" on a Biomeme run) — fall back to its first enabled tab
  // then. The tab is drawn either way, just disabled, so this is about where the *content* goes.
  // "about" and "files" are both file-independent, so they survive regardless.
  const view =
    enabledViews &&
    store.view !== "about" &&
    store.view !== "files" &&
    !(enabledViews as readonly ViewId[]).includes(store.view)
      ? enabledViews[0]
      : store.view;

  return (
    <div className="app">
      <header className="app__header" ref={headerRef} data-fit={fit}>
        <Logo onClick={showAbout} />
        <div className="app__views">
          <ViewSelector
            value={view}
            onChange={store.setView}
            // A run that hasn't decoded yet — locked behind the password prompt, or failed — has
            // nothing to show in any tab, so they all grey out. The strip itself stays: the
            // password prompt is a gate in the content area, not a reason for the app's chrome to
            // change shape, and a strip that vanished under it made unlocking look like the tabs
            // were something the file had earned.
            enabled={gated ? [] : enabledViews ?? undefined}
          />
        </div>
        <div className="app__header-spacer" />
        <DropZone onFiles={store.addFiles} />
      </header>

      <FileBar
        files={visibleFiles}
        runs={store.runs}
        plateFiles={store.plateFiles}
        activeId={store.activeId}
        modifiedIds={store.modifiedIds}
        inProgressIds={store.inProgressIds}
            incompleteIds={store.incompleteIds}
            pendingIds={store.pendingIds}
        onSelect={selectFile}
        onHide={(id) => store.setVisible(id, false)}
        experiments={store.experiments}
      />

      <main className="app__main">
        {view === "files" ? (
          <FilesTableView
            files={store.files}
            runs={store.runs}
            plateFiles={store.plateFiles}
            experiments={store.experiments}
            activeId={store.activeId}
            hiddenIds={store.hiddenIds}
            modifiedIds={store.modifiedIds}
            onSelectFile={selectFromTable}
            onSetVisible={store.setVisible}
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
        ) : isStandalonePlate ? (
          <>
            {view === "overview" && store.activePlateFile && (
              <StandalonePlateOverviewView
                file={active}
                result={store.activePlateFile}
                onRenameFile={(name) => void store.renameFile(active.id, name)}
                onDownload={downloadActiveFile}
                onClone={() => void cloneActiveFile()}
                autoEditName={editNameFor === active.id}
                onAutoEditHandled={clearEditName}
              />
            )}
            {view === "plates" && store.activePlateFile && (
              <StandalonePlateView file={active} result={store.activePlateFile} />
            )}
            {view === "raw" && <StandaloneRawView key={active.id} file={active} />}
          </>
        ) : isStandaloneProtocol ? (
          <>
            {view === "overview" && (
              <StandaloneProtocolOverview
                file={active}
                onRenameFile={(name) => void store.renameFile(active.id, name)}
                onDownload={downloadActiveFile}
                onClone={() => void cloneActiveFile()}
                autoEditName={editNameFor === active.id}
                onAutoEditHandled={clearEditName}
              />
            )}
            {view === "protocol" && store.activeProtocolFile !== null && (
              <StandaloneProtocolView
                key={active.id}
                file={active}
                runDefinition={store.activeProtocolFile}
                onChangeProtocol={(text) => store.setProtocolText(active.id, text)}
              />
            )}
            {view === "raw" && <StandaloneRawView key={active.id} file={active} />}
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
                  store.experiments.get(active.id) ?? {
                    name: active.name,
                    named: false,
                    date: null,
                    dateText: "",
                    fileName: active.name,
                  }
                }
                // Naming an experiment also names its file while it still carries the placeholder
                // one it was created under — see `nameExperiment`.
                onRename={(name) => nameExperiment(active.id, name)}
                // Only a `.zpcr` has an archive to write `zpcrweb.json` into; see
                // `analysisPersist.ts`'s `resolve`.
                namePersists={active.kind === "zpcr"}
                pending={isPendingExperiment(active.kind, zpcr)}
                files={store.files}
                onAttachPlate={(file) => void store.attachPlate(active.id, file)}
                onAttachProtocol={(file) => void store.attachProtocol(active.id, file)}
                onCreateProtocol={(fileName) => void createProtocolFor(active.id, fileName)}
                onCloneExperiment={cloneExperiment}
                onRenameFile={(name) => void store.renameFile(active.id, name)}
                onDownload={downloadActiveFile}
                autoEditName={editNameFor === active.id}
                onAutoEditHandled={clearEditName}
                autoFocusName={nameExperimentFor === active.id}
                onAutoFocusHandled={clearNameExperiment}
              />
            )}
            {view === "protocol" && (
              <ProtocolView
                zpcr={zpcr}
                file={active}
                addFiles={store.addFiles}
                pending={isPendingExperiment(active.kind, zpcr)}
                onChangeProtocol={(text) => store.setRunProtocolText(active.id, text)}
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
                key={active.id}
                zpcr={zpcr}
                fileId={active.id}
                attachPlate={store.attachPlate}
                files={store.files}
                addFiles={store.addFiles}
              />
            )}
            {view === "raw" && active.kind === "pcrd" && (
              <PcrdRawView
                key={active.id}
                zpcr={zpcr}
                documentXml={activeRun?.documentXml ?? ""}
                fileName={active.name}
              />
            )}
            {view === "raw" && active.kind === "zpcr" && (
              <RawFilesView key={active.id} zpcr={zpcr} settings={settings} />
            )}
            {/* A Biomeme run is a single JSON document rather than an archive, which is exactly
                the shape the standalone viewer handles. */}
            {view === "raw" && active.kind === "biomeme" && (
              <StandaloneRawView key={active.id} file={active} />
            )}
          </>
        )}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
