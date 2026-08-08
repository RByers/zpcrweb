import { useCallback, useEffect, useRef, useState } from "react";
import { SUPPORTED_EXTENSIONS } from "@zpcrweb/core";
import { FolderIcon, UploadIcon } from "./ViewIcons";

interface Props {
  onFiles: (files: FileList | File[]) => unknown;
  /** Render the large welcome variant. */
  large?: boolean;
  /** File input `accept` attribute. Defaults to every format the app can load. */
  accept?: string;
  /** Large-variant title text override, e.g. "Drop a .pltd or .plt.csv file here". */
  title?: string;
  /** Compact-variant label override, e.g. "+ attach plate". */
  compactLabel?: string;
  /**
   * Offer "add folder" beside "upload" — the whole-folder route, on browsers that have it.
   *
   * Supplying this turns the compact variant from a one-click picker into a two-item menu, so it
   * is passed only where opening a folder makes sense (the header, the welcome screen) and never
   * by the attach-a-plate/protocol controls, which want one specific file.
   */
  onAddFolder?: () => void;
  /** Grey out and ignore clicks/drops — for a control that's contextually unavailable (e.g.
   * plate-attach on a `.pcrd`). `disabledTitle` explains why, shown as a native hover tooltip
   * rather than always-visible text. */
  disabled?: boolean;
  disabledTitle?: string;
}

const DEFAULT_ACCEPT = SUPPORTED_EXTENSIONS.join(",");

export function DropZone({
  onFiles,
  large,
  accept = DEFAULT_ACCEPT,
  title,
  compactLabel,
  onAddFolder,
  disabled,
  disabledTitle,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [dragging, setDragging] = useState(false);
  const label = compactLabel ?? "load file";
  const menu = !!onAddFolder && !large && !disabled;

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      setDragging(false);
      if (e.dataTransfer.files.length) void onFiles(e.dataTransfer.files);
    },
    [onFiles, disabled],
  );

  // Same dismissal as the attach menus: a native <details> only closes on a second click of its
  // own <summary>, which isn't how anything else in the app behaves.
  useEffect(() => {
    if (!menu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const el = detailsRef.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [menu]);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  /**
   * The hidden picker, and the drop target's only child.
   *
   * It stays a direct child of `.dropzone` in every variant: the browser-automation harness reaches
   * the app's file picker as `.dropzone input[type="file"]` and drives it with
   * `DOM.setFileInputFiles`, which is the closest thing there is to a real user choosing a file.
   * Moving it would break that silently — the tests would still find *an* input, just not this one.
   */
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={accept}
      multiple
      hidden
      disabled={disabled}
      // Inside a <summary> in the menu variant, where a bubbling click would re-toggle the
      // <details> that the "Upload…" item has just closed.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        if (e.target.files?.length) void onFiles(e.target.files);
        e.target.value = "";
      }}
    />
  );

  const compactBody = (
    <span className="dropzone__compact mono">
      <UploadIcon />
      {/* Hidden on a narrow header, where the icon carries it alone — hence the `title`
          on the zone itself. */}
      <span className="dropzone__compact-label">{label}</span>
    </span>
  );

  if (menu) {
    return (
      <details className="dlmenu" ref={detailsRef}>
        <summary
          className={"dropzone" + (dragging ? " dropzone--active" : "")}
          title={label}
          aria-label={label}
          // Dropping onto the trigger still works, so the header stays a drop target whether or
          // not the menu behind it is open.
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          {compactBody}
          {fileInput}
        </summary>
        <div className="dlmenu__list">
          <button
            className="dlmenu__item mono"
            onClick={() => {
              close();
              inputRef.current?.click();
            }}
          >
            Upload…
          </button>
          <button
            className="dlmenu__item mono"
            onClick={() => {
              close();
              onAddFolder!();
            }}
          >
            Add folder…
          </button>
        </div>
      </details>
    );
  }

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
      {fileInput}
      {large ? (
        <>
          <div className="dropzone__icon mono">⇪</div>
          <div className="dropzone__title">
            {title ?? "Drop .zpcr, .pcrd, .pltd, .plt.csv or .prcl.txt files here"}
          </div>
          <div className="dropzone__sub">
            or <span className="dropzone__link">click to browse</span> · multiple files
            supported
          </div>
          {onAddFolder && (
            /* A whole folder, rather than files one at a time — the big drop area stays the drop
               area, so this is a separate line instead of turning the welcome screen into a menu.
               Its own click must not also reach the zone's "browse" handler. */
            <div className="dropzone__sub">
              or{" "}
              <button
                type="button"
                className="dropzone__folderbtn"
                onClick={(e) => {
                  e.stopPropagation();
                  onAddFolder();
                }}
              >
                <FolderIcon />
                add a folder
              </button>{" "}
              to open and save files in place
            </div>
          )}
        </>
      ) : (
        compactBody
      )}
    </div>
  );
}
