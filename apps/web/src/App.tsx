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

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
  }

  if (!active || !settings) {
    // The example goes through the `#load=` hash key rather than calling `addUrl` directly, so
    // the button and an external deep link are the same code path — and so the URL it produces
    // is one you can copy and send. Assigning an unchanged hash fires no `hashchange`, so a
    // repeat click (after a failed fetch, say) falls back to loading it directly.
    const loadExample = () => {
      const hash = formatLoadHash(EXAMPLE_FILE);
      if (window.location.hash.replace(/^#/, "") === hash) void store.addUrl(EXAMPLE_FILE);
      else window.location.hash = hash;
    };
    return (
      <div className="app app--empty">
        <header className="app__brand">
          <Logo onClick={showAbout} />
          <span className="app__tag">Bio-Rad CFX qPCR viewer</span>
        </header>
        {store.view === "about" ? (
          <AboutView onBack={leaveAbout} />
        ) : (
          <div className="app__welcome">
            <DropZone onFiles={store.addFiles} large />
            <button type="button" className="app__example mono" onClick={loadExample}>
              Load an example file
            </button>
          </div>
        )}
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
          <AboutView onBack={leaveAbout} />
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
