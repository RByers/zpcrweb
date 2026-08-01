import { useMemo, useRef } from "react";
import { useZpcrStore } from "./state/useZpcrStore";
import { useRunStaging, stagingRole } from "./state/useRunStaging";
import { EMPTY_STAGED_RUN, resolveStagedRun } from "./lib/protocolSource";
import { usePltdPassword } from "./state/pltdPassword";
import { formatLoadHash } from "./state/urlHash";
import { useHeaderFit } from "./state/useHeaderFit";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
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
import { StandaloneRawView } from "./components/views/StandaloneRawView";
import { StandaloneProtocolView } from "./components/views/StandaloneProtocolView";
import { AboutView } from "./components/views/AboutView";
import { InstrumentView } from "./components/views/InstrumentView";
import type { ViewId } from "./state/useZpcrStore";

const STANDALONE_VIEWS = ["plates", "raw"] as const;
/** A Biomeme run has no reference row and no `.Dcal` calibration files, so those two tabs are
 * disabled. Raw stays: the run *is* one JSON document, so there is no archive to browse
 * (`Zpcr.archive` is honestly empty) but there is very much a file to read — rendered by the
 * same {@link StandaloneRawView} a `.plt.csv` gets, for the same reason (one text file, no
 * container around it). */
const BIOMEME_VIEWS = ["overview", "curves", "plates", "raw"] as const;
/** A `.prcl.txt` is two things: a document to read (Overview, the annotated directive listing
 * of `protocol.md`) and an input to a run (Instrument, where it is staged). Nothing else applies
 * — it has no curves, no plate and no archive to browse. */
const PROTOCOL_VIEWS = ["overview", "instrument"] as const;

/** A `.pltd`/`.plt.csv` uploaded on its own, rather than a run — only two of the tabs apply. */
const isStandaloneKind = (kind: string) => kind === "pltd" || kind === "csv";

/** The file-backed tabs a given file kind supports, or `null` for "all of them". The tabs it
 * leaves out are still drawn — greyed out, see `ViewSelector` — so this decides what is *enabled*,
 * not what exists. Shared by the normal render and the Instrument view's early return, which
 * needs the same answer to draw the rest of the tab strip while it is the selected one.
 *
 * Typed as a non-empty tuple so the view fallback below can take `[0]` — a file with no enabled
 * tab at all would leave nowhere to fall back to. */
function enabledViewsFor(kind: string): readonly [ViewId, ...ViewId[]] | null {
  if (isStandaloneKind(kind)) return STANDALONE_VIEWS;
  if (kind === "biomeme") return BIOMEME_VIEWS;
  if (kind === "prcl") return PROTOCOL_VIEWS;
  return null;
}

/**
 * The run offered on the welcome screen, served from `public/examples/` (a symlink to the
 * repo's `samples/`, so there's one copy of the file). Relative to the page, so it works on a
 * dev server, on a subpath deploy, and offline-cached alike.
 */
const EXAMPLE_FILE = "examples/20260726_S183-S185_RVP.zpcr";

/** The wordmark, doubling as the link to the About page. Split so a narrow header can drop the
 * "//web" tail (see `.app__logo-rest` in `app.css` and `useHeaderFit`) and keep "zpcr" — the
 * full mark plus the seven view tabs plus the load button don't fit across a phone in portrait. */
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
  // Where "← back" on the About page returns to, so opening About and leaving again is a no-op.
  const lastView = useRef<ViewId>("curves");
  if (store.view !== "about") lastView.current = store.view;
  const showAbout = () => store.setView("about");
  const leaveAbout = () => store.setView(lastView.current);

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
    if (await store.addFiles([file])) store.setView("overview");
  };

  /**
   * What a file chip does. Everywhere but the Instrument view it means the one thing it always
   * meant — *show me this file* — which is the app's **primary selection**, `activeId`, drawn in
   * the bar's usual cyan. Every kind can hold it: a run, a standalone plate, and (since it has an
   * Overview of its own) a `.prcl.txt`.
   *
   * The Instrument view asks a different question — what is the run made of — so there the chips
   * split in two. The run is the primary one, and selecting another *switches* it rather than
   * toggling: it can't be cleared, and there is always one. The plate and protocol files staged
   * over it are auxiliary (magenta), and those do toggle on and off. Selecting a run here also
   * makes it the active file, so it is what you land on when you leave the view — without that,
   * a bar whose only action was staging left no way to change what the rest of the app was
   * pointed at from here at all.
   */
  const selectFile = (id: string) => {
    const f = store.files.find((x) => x.id === id);
    if (!f) return;
    if (store.view !== "instrument" || stagingRole(f.kind) === "run") store.setActive(id);
    else staging.toggle(id);
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
              enabled={active ? enabledViewsFor(active.kind) ?? undefined : []}
            />
          </div>
          <div className="app__header-spacer" />
          <DropZone onFiles={store.addFiles} />
        </header>
        {store.files.length > 0 && (
          <FileBar
            files={store.files}
            runs={store.runs}
            plateFiles={store.plateFiles}
            // The cyan chip here is the *run being staged*, not `store.activeId`: this view shows
            // no file, and a protocol loaded into it is the active file while the run is what the
            // bar has to name. Selecting one makes it active too (see `selectFile`).
            activeId={staging.selection.runId}
            stagedIds={staging.stagedIds}
            modifiedIds={store.modifiedIds}
            onSelect={selectFile}
            onRemove={store.remove}
            experiments={store.experiments}
          />
        )}
        <main className="app__main">
          <InstrumentView onOpenRun={openRun} staged={staged} />
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
  const enabledViews = enabledViewsFor(active.kind);
  // `store.view` is global (not per-file), so switching entries can land on a view this file has
  // no answer for (e.g. "calibration" on a Biomeme run) — fall back to its first enabled tab
  // then. The tab is drawn either way, just disabled, so this is about where the *content* goes.
  // "about" is file-independent, so it survives regardless.
  const view =
    enabledViews &&
    store.view !== "about" &&
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
        files={store.files}
        runs={store.runs}
        plateFiles={store.plateFiles}
        activeId={store.activeId}
        modifiedIds={store.modifiedIds}
        onSelect={selectFile}
        onRemove={store.remove}
        experiments={store.experiments}
      />

      <main className="app__main">
        {view === "about" ? (
          <AboutView
            onFiles={store.addFiles}
            exampleHref={exampleHref}
            onLoadExample={loadExample}
            onBack={leaveAbout}
          />
        ) : isStandalonePlate ? (
          <>
            {view === "plates" && store.activePlateFile && (
              <StandalonePlateView file={active} result={store.activePlateFile} />
            )}
            {view === "raw" && <StandaloneRawView key={active.id} file={active} />}
          </>
        ) : isStandaloneProtocol ? (
          store.activeProtocolFile !== null && (
            <StandaloneProtocolView file={active} runDefinition={store.activeProtocolFile} />
          )
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
                // Saving the file to disk is what un-modifies it: the copy leaving the browser
                // is the one carrying the edits, so the chip's delete stops asking twice.
                onDownload={() => {
                  const bytes = store.exportBytes(active.id);
                  store.markDownloaded(active.id);
                  return bytes;
                }}
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
