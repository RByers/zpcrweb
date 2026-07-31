import { useCallback, useRef, useState } from "react";
import { UploadIcon } from "./ViewIcons";

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
  /** Grey out and ignore clicks/drops — for a control that's contextually unavailable (e.g.
   * plate-attach on a `.pcrd`). `disabledTitle` explains why, shown as a native hover tooltip
   * rather than always-visible text. */
  disabled?: boolean;
  disabledTitle?: string;
}

const DEFAULT_ACCEPT = ".zpcr,.pcrd,.pltd,.csv,.json";

export function DropZone({
  onFiles,
  large,
  accept = DEFAULT_ACCEPT,
  title,
  compactLabel,
  disabled,
  disabledTitle,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const label = compactLabel ?? "load file";

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      setDragging(false);
      if (e.dataTransfer.files.length) void onFiles(e.dataTransfer.files);
    },
    [onFiles, disabled],
  );

  return (
    <div
      className={
        "dropzone" +
        (large ? " dropzone--large" : "") +
        (dragging ? " dropzone--active" : "") +
        (disabled ? " dropzone--disabled" : "")
      }
      title={disabled ? disabledTitle : large ? undefined : label}
      aria-label={large ? undefined : label}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        disabled={disabled}
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
        <span className="dropzone__compact mono">
          <UploadIcon />
          {/* Hidden on a narrow header, where the icon carries it alone — hence the `title`
              on the zone itself below. */}
          <span className="dropzone__compact-label">{label}</span>
        </span>
      )}
    </div>
  );
}
