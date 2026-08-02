/**
 * The file bar's own toggle: a simple table grid, standing for "every loaded file, as rows" —
 * what `FilesTableView.tsx` actually shows once opened. Same drawing conventions as
 * `FileIcons.tsx`: a 16×16 viewBox, `currentColor` strokes at 1.3px, `aria-hidden` (the button
 * carries its own `aria-label`).
 */
export function FilesViewIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.3" />
      <path d="M1.8 6.4h12.4M6.4 6.4v6.8" />
    </svg>
  );
}
