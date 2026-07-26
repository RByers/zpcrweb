import { useZpcrStore } from "./state/useZpcrStore";
import { usePltdPassword } from "./state/pltdPassword";
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

const STANDALONE_VIEWS = ["plates", "raw"] as const;

export function App() {
  const store = useZpcrStore();
  const { active, activeRun, settings } = store;
  const [, setPassword] = usePltdPassword();

  if (store.loading) {
    return <div className="splash mono">initializing…</div>;
  }

  if (!active || !settings) {
    return (
      <div className="app app--empty">
        <header className="app__brand">
          <span className="app__logo mono">zpcr//web</span>
          <span className="app__tag">Bio-Rad CFX qPCR viewer</span>
        </header>
        <DropZone onFiles={store.addFiles} large />
        {store.error && <div className="app__error mono">{store.error}</div>}
      </div>
    );
  }

  const isStandalonePlate = active.kind === "pltd" || active.kind === "csv";
  const zpcr = isStandalonePlate ? null : activeRun?.zpcr ?? null;
  // `store.view` is global (not per-file), so switching to a standalone entry can land on a
  // view its restricted tab set doesn't have (e.g. "curves") — fall back to "plates" then.
  const view = isStandalonePlate && !STANDALONE_VIEWS.includes(store.view as (typeof STANDALONE_VIEWS)[number])
    ? "plates"
    : store.view;

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo mono">zpcr//web</span>
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
        {isStandalonePlate ? (
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
            {view === "raw" && active.kind === "zpcr" && <RawFilesView key={active.id} zpcr={zpcr} />}
          </>
        )}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
