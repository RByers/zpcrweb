import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Zpcr } from "@zpcrweb/core";
import { useZpcrStore } from "./state/useZpcrStore";
import { useCfxDevice } from "./state/useCfxDevice";
import { useRunWatch } from "./state/useRunWatch";
import { useRunNaming } from "./state/useRunNaming";
import { useRunStaging, stagingRole } from "./state/useRunStaging";
import { EMPTY_STAGED_RUN, resolveStagedRun } from "./lib/protocolSource";
import { usePltdPassword } from "./state/pltdPassword";
import { formatLoadHash } from "./state/urlHash";
import { cloneFileName } from "./lib/cloneName";
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
/** A `.prcl.txt` is a document to read (Protocol, the annotated directive listing of
 * `protocol.md`), a file to inspect verbatim (Raw — it's plain text, so this is the same view a
 * `.plt.csv` gets) and an input to a run (Instrument, where it is staged). Overview stays minimal
 * — just the filename, per {@link StandaloneProtocolOverview} — since Protocol is where the
 * content actually lives. It has no curves and no plate. */
const PROTOCOL_VIEWS = ["overview", "protocol", "raw", "instrument"] as const;

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
 * not, and the extreme case is the seed file written the moment Start run is clicked
 * (`core/runSeed.ts`): a protocol, a plate, a name, and nothing else. Curves with no plate read,
 * Reference with no readings to compare against `FactoryRefRowCal`, and Calibration with no
 * calibration set each render an empty frame that reads as a broken view rather than an absent
 * one — so each is greyed out with the same "not available for this file" the other kinds already
 * get, and comes back on its own as the instrument produces the data, since every snapshot
 * re-parses.
 */
function runViews(zpcr: Zpcr): readonly [ViewId, ...ViewId[]] {
  const views: ViewId[] = ["overview", "protocol"];
  const read = zpcr.reads.length > 0;
  if (read) views.push("curves");
  views.push("plates");
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
  // Which files make up the run the Instrument view would start. Held here rather than inside that
  // view because the file bar — which lives in this component — is the control that edits it.
  const staging = useRunStaging(store.files, store.activeId);
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
   * The two names the Instrument view collects for the run it would start. Held here rather than
   * in the view because the run watcher below needs the file name — and because leaving the
   * Instrument view for a moment must not forget what was typed.
   */
  const runNaming = useRunNaming();
  const runWatch = useRunWatch(
    instrument,
    useCallback(
      async (file: File, previousId: string | null, freshStart: boolean) => {
        const wasWatchingIt = store.activeId !== null && store.activeId === previousId;
        return store.addFiles([file], { activate: wasWatchingIt || freshStart, modified: true });
      },
      [store],
    ),
    runNaming,
  );
  /**
   * Take the `.zpcr` the Instrument view writes at the click on Start run into the file list
   * (`core/runSeed.ts`): the run's protocol, plate and name, minutes before the instrument has
   * produced a single plate read.
   *
   * It is an ordinary added file — the bar, IndexedDB, the files table — and `modified`, because
   * it exists nowhere but this browser until it is saved. `adopt` tells the watcher this is the
   * file its first snapshot supersedes; the snapshots take the same name (both from
   * `useRunNaming`), so the store replaces it in place rather than growing a second chip.
   */
  const seedRunFile = useCallback(
    async (file: File) => {
      const id = await store.addFiles([file], { activate: true, modified: true });
      if (id) runWatch.adopt(id);
    },
    [store, runWatch],
  );
  // Memoized, and skipped entirely off the Instrument view: resolving decodes a run's plate
  // and, for a staged `.plt.csv`, re-parses it against the run's calibration set — real work to
  // repeat on every render of a view that never looks at the result.
  const onInstrument = store.view === "instrument";
  const staged = useMemo(
    () =>
      onInstrument
        ? resolveStagedRun(
            staging.selection,
            store.files,
            store.runs,
            store.plateFiles,
            store.protocolFiles,
            pltdPassword,
            store.experiments,
          )
        : EMPTY_STAGED_RUN,
    [
      onInstrument,
      staging.selection,
      store.files,
      store.runs,
      store.plateFiles,
      store.protocolFiles,
      pltdPassword,
      store.experiments,
    ],
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
   * What a file chip does. Everywhere but the Instrument view it means the one thing it always
   * meant — *show me this file* — which is the app's **primary selection**, `activeId`, drawn in
   * the bar's usual cyan. Every kind can hold it: a run, a standalone plate, and (since it has an
   * Overview of its own) a `.prcl.txt`. Switching there is never blocked, run in progress or not
   * — reading Curves while a run cycles is the headline use of the connection staying open across
   * tabs (see `instrument` above), and it would defeat that to pin the selection.
   *
   * The Instrument view asks a different question — what is the run made of — so there the chips
   * split in two. The run is the primary one, and selecting another *switches* it rather than
   * toggling: it can't be cleared, and there is always one. The plate and protocol files staged
   * over it are auxiliary (magenta), and those do toggle on and off. Selecting a run here also
   * makes it the active file, so it is what you land on when you leave the view — without that,
   * a bar whose only action was staging left no way to change what the rest of the app was
   * pointed at from here at all.
   *
   * A run live on the instrument owns the **whole bar** while this view is showing it: switching
   * to some other run would abandon watching the one in progress, and toggling an override would
   * claim the plate or protocol *this* run is using is something other than what it actually is —
   * both are confusing in the same way, so both are refused. The effect below is what keeps the
   * run pinned there on arrival; this only has to refuse the escape.
   */
  const selectFile = (id: string) => {
    const f = store.files.find((x) => x.id === id);
    if (!f) return;
    if (store.view === "instrument" && runActive) return;
    if (store.view !== "instrument" || stagingRole(f.kind) === "run") store.setActive(id);
    else staging.toggle(id);
  };
  /**
   * Arriving at the Instrument view while a run is live snaps the selection to it, even if the
   * user had been looking at something else — that's the one file this view can usefully show
   * while a run owns the selection (see `selectFile` above). `runWatch.fileId` rather than
   * `store.activeId` because the two can have drifted apart: a snapshot pulled while the user was
   * elsewhere doesn't activate itself (`AddFilesOptions.activate`), so the store's `activeId` may
   * still be a stale one from before they left. Keyed off `store.view` alone, not `runWatch.fileId`
   * too, so a later snapshot of the *same* run doesn't re-snap someone who has since staged an
   * override.
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

  const exampleHref = `#${formatLoadHash(EXAMPLE_FILE)}`;
  const loadExample = (e: { preventDefault: () => void }) => {
    if (window.location.hash !== exampleHref) return; // let the navigation do the work
    e.preventDefault();
    void store.addUrl(EXAMPLE_FILE);
  };

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
  }

  // The Instrument view operates on an instrument, not a file, so it renders the same way
  // whether or not anything is loaded — and is reachable from the welcome screen, which is where someone
  // with a cycler and no files yet actually starts. It keeps the file bar, because starting a run
  // needs files: the chip in cyan is the run to start — the same "primary selection" highlight
  // the bar carries everywhere — and the plate/protocol chips staged over it are the auxiliary
  // `stagedIds`, in magenta. A `.prcl.txt` selected from a tab it has no answer for is *not*
  // forced here any more: it has an Overview of its own now, which the fallback below picks as
  // its first enabled tab.
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
            // The cyan chip here is the *run being staged*, not `store.activeId`: this view shows
            // no file, and a protocol loaded into it is the active file while the run is what the
            // bar has to name. Selecting one makes it active too (see `selectFile`).
            activeId={staging.selection.runId}
            stagedIds={staging.stagedIds}
            modifiedIds={store.modifiedIds}
            inProgressIds={store.inProgressIds}
            activeLocked={runActive}
            onSelect={selectFile}
            onHide={(id) => store.setVisible(id, false)}
            experiments={store.experiments}
          />
        )}
        <main className="app__main">
          <InstrumentView
            onOpenRun={openRun}
            staged={staged}
            instrument={instrument}
            runWatch={runWatch}
            naming={runNaming}
            onRunSeeded={seedRunFile}
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
        <AboutView onFiles={store.addFiles} exampleHref={exampleHref} onLoadExample={loadExample} />
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
                    date: null,
                    dateText: "",
                    fileName: active.name,
                  }
                }
                onRename={(name) => store.updateSettings({ experimentName: name })}
                // Only a `.zpcr` has an archive to write `zpcrweb.json` into; see
                // `analysisPersist.ts`'s `resolve`.
                namePersists={active.kind === "zpcr"}
                onRenameFile={(name) => void store.renameFile(active.id, name)}
                onDownload={downloadActiveFile}
                onClone={() => void cloneActiveFile()}
                autoEditName={editNameFor === active.id}
                onAutoEditHandled={clearEditName}
              />
            )}
            {view === "protocol" && (
              <ProtocolView zpcr={zpcr} file={active} addFiles={store.addFiles} />
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
