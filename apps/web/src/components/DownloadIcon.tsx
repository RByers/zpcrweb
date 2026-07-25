/** A floppy disk with a download arrow in place of its write-protect shutter — used on the
 * Raw files view's "Download" toolbar button (see `RawFilesView`/`PcrdRawView`). */
export function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 2h8l3 3v8.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <rect x="4.5" y="9" width="7" height="4.5" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M8 3v4m0 0-1.6-1.7M8 7l1.6-1.7"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
