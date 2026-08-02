/** Two overlapping documents — used on "Clone" buttons that extract part of a composite file (a
 * run's plate or protocol) into its own independent file entry. Same drawing conventions as
 * `DownloadIcon`. */
export function CloneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="5.5"
        y="2.5"
        width="8"
        height="9.5"
        rx="0.8"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 12v1a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8h2.7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
