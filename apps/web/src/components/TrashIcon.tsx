/** A waste bin — the second, armed state of a file chip's delete button, where the first click
 * was a request and this click is the one that throws edited work away (see `FileBar`). Same
 * drawing conventions as the other icons here: a 16×16 viewBox, `currentColor` strokes,
 * `aria-hidden` because the button carries its own label. */
export function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4h11" />
      <path d="M6 4V2.5h4V4" />
      <path d="M4 4l.7 9.2h6.6L12 4" />
      <path d="M6.6 6.5v4.6M9.4 6.5v4.6" />
    </svg>
  );
}
