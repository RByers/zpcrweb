import { useZpcrStore } from "./state/useZpcrStore";
import { DropZone } from "./components/DropZone";
import { FileBar } from "./components/FileBar";
import { ViewSelector } from "./components/ViewSelector";
import { OverviewView } from "./components/views/OverviewView";
import { CurvesView } from "./components/views/CurvesView";
import { RawFilesView } from "./components/views/RawFilesView";

export function App() {
  const store = useZpcrStore();
  const { active, settings } = store;

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

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__logo mono">zpcr//web</span>
        <ViewSelector
          value={view}
          onChange={(v) => store.updateSettings({ view: v })}
        />
        <div className="app__header-spacer" />
        <DropZone onFiles={store.addFiles} />
      </header>

      <FileBar
        files={store.files}
        activeId={store.activeId}
        onSelect={store.setActive}
        onRemove={store.remove}
      />

      <main className="app__main">
        {view === "overview" && <OverviewView zpcr={active.zpcr} />}
        {view === "curves" && (
          <CurvesView
            zpcr={active.zpcr}
            settings={settings}
            onChange={store.updateSettings}
          />
        )}
        {view === "raw" && <RawFilesView zpcr={active.zpcr} />}
      </main>

      {store.error && <div className="app__error mono">{store.error}</div>}
    </div>
  );
}
