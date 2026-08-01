import { useRef } from "react";
import { useZpcrStore } from "./state/useZpcrStore";
import { useRunStaging } from "./state/useRunStaging";
import { resolveStagedRun } from "./lib/protocolSource";
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
import { AboutView } from "./components/views/AboutView";
import { DeviceView } from "./components/views/DeviceView";
import type { ViewId } from "./state/useZpcrStore";

const STANDALONE_VIEWS = ["plates", "raw"] as const;
/** A Biomeme run has no reference row, no `.Dcal` calibration files and no raw archive to
 * browse (`Zpcr.archive` is honestly empty) — those three tabs have nothing to show. */
const BIOMEME_VIEWS = ["overview", "curves", "plates"] as const;
/** A `.prcl.txt` is staged, not viewed — the Device view is the only place it does anything. */
const PROTOCOL_VIEWS = ["device"] as const;

/** A `.pltd`/`.plt.csv` uploaded on its own, rather than a run — it gets a restricted tab set. */
const isStandaloneKind = (kind: string) => kind === "pltd" || kind === "csv";

/** The file-backed tabs a given file kind supports, or `null` for "all of them". Shared by the
 * normal render and the Device view's early return, which needs the same answer to draw the rest
 * of the tab strip while it is the selected one.
 *
 * Typed as a non-empty tuple so the view fallback below can take `[0]` — a restricted set with no
 * tabs in it would leave nowhere to fall back to. */
function restrictedViewsFor(kind: string): readonly [ViewId, ...ViewId[]] | null {
  if (isStandaloneKind(kind)) return STANDALONE_VIEWS;
  if (kind === "biomeme") return BIOMEME_VIEWS;
  // A `.prcl.txt` is an *input to* a run, not a run to look at — it has no file-backed view, and
  // Device is where it is used (`useRunStaging.ts`). Returning the Device tab alone keeps the
  // fallback below total: there is always somewhere for a file to send you.
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
 * full mark plus five view tabs plus the load button don't fit across a phone in portrait. */
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
  const [, setPassword] = usePltdPassword();
  // Called before the early returns below, as hook order demands. The deps are what changes the
  // header's natural width other than a resize: the selected tab (level 2 keeps its label) and
  // the active file (a standalone plate shows two tabs, a run five).
  const { ref: headerRef, fit } = useHeaderFit([store.view, store.activeId]);
  // Which files make up the run the Device view would start. Held here rather than inside that
  // view because the file bar — which lives in this component — is the control that edits it.
  const staging = useRunStaging(store.files, store.activeId);
  const [pltdPassword] = usePltdPassword();
  const staged = resolveStagedRun(
    staging.selection,
    store.files,
    store.runs,
    store.plateFiles,
    store.protocolFiles,
    pltdPassword,
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
  // `addFiles` path as a drop — and then leaves the Device view for it, since staying on a view
  // that shows no file would make a successful open look like nothing happened. Only on success:
  // a rejected archive leaves you where you are, with the error banner.
  const openRun = async (file: File) => {
    if (await store.addFiles([file])) store.setView("overview");
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

  // The Device view operates on an instrument, not a file, so it renders the same way whether or
  // not anything is loaded — and is reachable from the welcome screen, which is where someone
  // with a cycler and no files yet actually starts. It keeps the file bar, because starting a run
  // needs files: there a chip means "part of the run being staged" rather than "the file you are
  // looking at", which is why it gets `selectedIds` and the staging toggle instead of `activeId`.
  // A `.prcl.txt` selected from another view has nowhere else to be rendered (it has no
  // file-backed tab), so it lands here too rather than leaving the content area blank.
  if (store.view === "device" || (active?.kind === "prcl" && store.view !== "about")) {
    return (
      <div className={store.files.length > 0 ? "app" : "app app--nofiles"}>
        <header className="app__header" ref={headerRef} data-fit={fit}>
          <Logo onClick={showAbout} />
          <div className="app__views">
            <ViewSelector
              value="device"
              onChange={store.setView}
              // With no file loaded there are no file-backed tabs to offer — only Device.
              views={active ? restrictedViewsFor(active.kind)?.slice() : []}
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
            activeId={store.activeId}
            selectedIds={staging.selectedIds}
            onSelect={staging.toggle}
            onRemove={store.remove}
          />
        )}
        <main className="app__main">
          <DeviceView onOpenRun={openRun} staged={staged} />
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
        <div className="app__welcomedevice">
          <button className="btn" onClick={() => store.setView("device")}>
            Connect an instrument over USB
          </button>
        </div>
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  const isStandalonePlate = isStandaloneKind(active.kind);
  const isBiomeme = active.kind === "biomeme";
  const zpcr = isStandalonePlate ? null : activeRun?.zpcr ?? null;
  const restrictedViews = restrictedViewsFor(active.kind);
  // `store.view` is global (not per-file), so switching to a restricted entry can land on a view
  // its tab set doesn't have (e.g. "raw" on a Biomeme run) — fall back to its first tab then.
  // "about" is file-independent, so it survives regardless.
  const view =
    restrictedViews &&
    store.view !== "about" &&
    !(restrictedViews as readonly ViewId[]).includes(store.view)
      ? restrictedViews[0]
      : store.view;

  return (
    <div className="app">
      <header className="app__header" ref={headerRef} data-fit={fit}>
        <Logo onClick={showAbout} />
        {(zpcr || isStandalonePlate) && (
          <div className="app__views">
            <ViewSelector
              value={view}
              onChange={store.setView}
              views={restrictedViews ? [...restrictedViews] : undefined}
            />
          </div>
        )}
        <div className="app__header-spacer" />
        <DropZone onFiles={store.addFiles} />
      </header>

      <FileBar
        files={store.files}
        runs={store.runs}
        plateFiles={store.plateFiles}
        activeId={store.activeId}
        onSelect={store.setActive}
        onRemove={store.remove}
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
                onDownload={() => store.exportBytes(active.id)}
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
          </>
        )}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
