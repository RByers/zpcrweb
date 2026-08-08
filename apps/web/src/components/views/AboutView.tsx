import { DropZone } from "../DropZone";

interface Props {
  onFiles: (files: FileList | File[]) => unknown;
  /** `#load=…` hash for the example run. A real href, so the browser offers "Copy link
   * address" on it — see `App`'s `exampleHref`. */
  exampleHref: string;
  onLoadExample: (e: { preventDefault: () => void }) => void;
  /** Create an empty experiment and go name it (`App`'s `newExperiment`). Sits here because this
   * page is the app's empty state, and "I have a cycler and no files" is exactly who needs it —
   * the other way in is cloning a run you already have, which needs a run first. */
  onNewExperiment: () => void;
  /** Grant the app a folder to open and save files in place — omitted on browsers without the
   * File System Access API, which is where the whole feature is absent. */
  onAddFolder?: () => void;
  /** Return to the previous view. Omitted on the welcome screen, where there's nothing to go
   * back to — with no file loaded this page *is* the empty state. */
  onBack?: () => void;
}

/** The About page (`#view=about`), reached by clicking the logo — and, with no file loaded, the
 * welcome screen itself. One view serves both: the credits sit above the drop target, so the
 * first thing a new user sees says what this is and that their data stays put. Needs no file to
 * render. */
export function AboutView({
  onFiles,
  exampleHref,
  onLoadExample,
  onNewExperiment,
  onAddFolder,
  onBack,
}: Props) {
  return (
    <div className="about">
      <div className="about__card">
        <h1 className="about__logo mono">zpcr//web</h1>
        <p className="about__line">Bio-Rad CFX qPCR output analyzer</p>
        <p className="about__line about__privacy">
          All run data processed locally, nothing leaves your device
        </p>
        <p className="about__line about__warning">
          Unofficial and likely buggy, use at your own risk
        </p>

        <DropZone onFiles={onFiles} large onAddFolder={onAddFolder} />
        <a className="about__example mono" href={exampleHref} onClick={onLoadExample}>
          Load an example file
        </a>
        {/* The other half of "what can I do here": open a file you have, or start an experiment you
            don't have yet. A button rather than a link — it creates something rather than
            navigating, and there is no URL that would mean it. */}
        <button className="about__example mono" onClick={onNewExperiment}>
          New experiment
        </button>

        <p className="about__line">
          Copyright{" "}
          <a href="https://lab.rbyers.ca/" target="_blank" rel="noreferrer">
            Rick Byers
          </a>
        </p>
        <p className="about__line">
          <a
            href="https://github.com/RByers/zpcrweb"
            target="_blank"
            rel="noreferrer"
          >
            github.com/RByers/zpcrweb
          </a>
        </p>
        {onBack && (
          <button className="about__back mono" onClick={onBack}>
            ← back
          </button>
        )}
      </div>
    </div>
  );
}
