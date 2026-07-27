import { useRef } from "react";
import { useZpcrStore } from "./state/useZpcrStore";
import { usePltdPassword } from "./state/pltdPassword";
import { formatLoadHash } from "./state/urlHash";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
import { ViewSelector } from "./components/ViewSelector";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { OverviewView } from "./components/views/OverviewView";
import { CurvesView } from "./components/views/CurvesView";
import { ReferenceView } from "./components/views/ReferenceView";
import { PlatesView } from "./components/views/PlatesView";
import { RawFilesView } from "./components/views/RawFilesView";
import { PcrdRawView } from "./components/views/PcrdRawView";
import { StandalonePlateView } from "./components/views/StandalonePlateView";
import { StandaloneRawView } from "./components/views/StandaloneRawView";
import { AboutView } from "./components/views/AboutView";
import type { ViewId } from "./state/useZpcrStore";

const STANDALONE_VIEWS = ["plates", "raw"] as const;

/**
 * The run offered on the welcome screen, served from `public/examples/` (a symlink to the
 * repo's `samples/`, so there's one copy of the file). Relative to the page, so it works on a
 * dev server, on a subpath deploy, and offline-cached alike.
 */
const EXAMPLE_FILE = "examples/20260726_S183-S185_RVP.zpcr";

/** The wordmark, doubling as the link to the About page. */
function Logo({ onClick }: { onClick: () => void }) {
  return (
    <button className="app__logo mono" onClick={onClick} title="About zpcrweb">
      zpcr//web
    </button>
  );
}

export function App() {
  const store = useZpcrStore();
  const { active, activeRun, settings } = store;
  const [, setPassword] = usePltdPassword();
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
  const exampleHref = `#${formatLoadHash(EXAMPLE_FILE)}`;
  const loadExample = (e: { preventDefault: () => void }) => {
    if (window.location.hash !== exampleHref) return; // let the navigation do the work
    e.preventDefault();
    void store.addUrl(EXAMPLE_FILE);
  };

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
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
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  const isStandalonePlate = active.kind === "pltd" || active.kind === "csv";
  const zpcr = isStandalonePlate ? null : activeRun?.zpcr ?? null;
  // `store.view` is global (not per-file), so switching to a standalone entry can land on a
  // view its restricted tab set doesn't have (e.g. "curves") — fall back to "plates" then.
  // "about" is file-independent, so it survives regardless.
  const view =
    isStandalonePlate &&
    store.view !== "about" &&
    !STANDALONE_VIEWS.includes(store.view as (typeof STANDALONE_VIEWS)[number])
      ? "plates"
      : store.view;

  return (
    <div className="app">
      <header className="app__header">
        <Logo onClick={showAbout} />
        {(zpcr || isStandalonePlate) && (
          <ViewSelector
            value={view}
            onChange={store.setView}
            views={isStandalonePlate ? [...STANDALONE_VIEWS] : undefined}
          />
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
                fileKind={active.kind}
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
