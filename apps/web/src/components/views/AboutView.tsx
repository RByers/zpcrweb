import { DropZone } from "../DropZone";

interface Props {
  onFiles: (files: FileList | File[]) => void | Promise<void>;
  onLoadExample: () => void;
  /** Return to the previous view. Omitted on the welcome screen, where there's nothing to go
   * back to — with no file loaded this page *is* the empty state. */
  onBack?: () => void;
}

/** The About page (`#view=about`), reached by clicking the logo — and, with no file loaded, the
 * welcome screen itself. One view serves both: the credits sit above the drop target, so the
 * first thing a new user sees says what this is and that their data stays put. Needs no file to
 * render. */
export function AboutView({ onFiles, onLoadExample, onBack }: Props) {
  return (
    <div className="about">
      <div className="about__card">
        <h1 className="about__logo mono">zpcr//web</h1>
        <p className="about__line">Bio-Rad CFX qPCR output analyzer</p>
        <p className="about__line about__privacy">
          All run data processed locally, nothing leaves your device
        </p>

        <DropZone onFiles={onFiles} large />
        <button type="button" className="about__example mono" onClick={onLoadExample}>
          Load an example file
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
