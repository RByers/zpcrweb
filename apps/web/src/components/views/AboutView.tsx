/** The About page, reached by clicking the logo (`#view=about`). Deliberately static: no file
 * needs to be loaded for it to render, so it also works from the empty state. */
export function AboutView({ onBack }: { onBack: () => void }) {
  return (
    <div className="about">
      <div className="about__card">
        <h1 className="about__logo mono">zpcr//web</h1>
        <p className="about__line">Bio-Rad CFX qPCR output analyzer</p>
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
        <button className="about__back mono" onClick={onBack}>
          ← back
        </button>
      </div>
    </div>
  );
}
