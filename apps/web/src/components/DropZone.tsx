import { useCallback, useRef, useState } from "react";

interface Props {
  onFiles: (files: FileList | File[]) => void | Promise<void>;
  /** Render the large welcome variant. */
  large?: boolean;
  /** File input `accept` attribute. Defaults to every format the app can load. */
  accept?: string;
  /** Large-variant title text override, e.g. "Drop a .pltd or .plt.csv file here". */
  title?: string;
  /** Compact-variant label override, e.g. "+ attach plate". */
  compactLabel?: string;
}

const DEFAULT_ACCEPT = ".zpcr,.pcrd,.pltd,.csv";

export function DropZone({ onFiles, large, accept = DEFAULT_ACCEPT, title, compactLabel }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) void onFiles(e.dataTransfer.files);
    },
    [onFiles],
  );

  return (
    <div
      className={
        "dropzone" +
        (large ? " dropzone--large" : "") +
        (dragging ? " dropzone--active" : "")
      }
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void onFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {large ? (
        <>
          <div className="dropzone__icon mono">⇪</div>
          <div className="dropzone__title">{title ?? "Drop .zpcr, .pcrd, .pltd or .plt.csv files here"}</div>
          <div className="dropzone__sub">
            or <span className="dropzone__link">click to browse</span> · multiple files
            supported
          </div>
        </>
      ) : (
        <span className="dropzone__compact mono">{compactLabel ?? "+ load file"}</span>
      )}
    </div>
  );
}
