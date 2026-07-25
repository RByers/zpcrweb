import { useZpcrStore } from "./state/useZpcrStore";
import { usePltdPassword } from "./state/pltdPassword";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
import { ViewSelector } from "./components/ViewSelector";
import { PasswordPrompt } from "./components/PasswordPrompt";
import { OverviewView } from "./components/views/OverviewView";
import { CurvesView } from "./components/views/CurvesView";
import { RawFilesView } from "./components/views/RawFilesView";
import { PcrdRawView } from "./components/views/PcrdRawView";

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

  const view = settings.view;
  const zpcr = activeRun?.zpcr ?? null;

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo mono">zpcr//web</span>
        {zpcr && (
          <ViewSelector
            value={view}
            onChange={(v) => store.updateSettings({ view: v })}
          />
        )}
        <div className="app__header-spacer" />
        <DropZone onFiles={store.addFiles} />
      </header>

      <FileBar
        files={store.files}
        runs={store.runs}
        activeId={store.activeId}
        onSelect={store.setActive}
        onRemove={store.remove}
      />

      <main className="app__main">
        {!zpcr ? (
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
            {view === "overview" && <OverviewView zpcr={zpcr} />}
            {view === "curves" && (
              <CurvesView
                zpcr={zpcr}
                settings={settings}
                onChange={store.updateSettings}
              />
            )}
            {view === "raw" && active.kind === "pcrd" && (
              <PcrdRawView zpcr={zpcr} documentXml={activeRun?.documentXml ?? ""} />
            )}
            {view === "raw" && active.kind === "zpcr" && <RawFilesView zpcr={zpcr} />}
          </>
        )}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
