/**
 * The parts of the File System Access API that TypeScript's `lib.dom` doesn't declare yet.
 *
 * `lib.dom` (5.9) has `FileSystemHandle`, `FileSystemDirectoryHandle` and `createWritable`, because
 * the origin-private file system needs them. What it lacks is everything to do with *user-granted*
 * directories — the picker, the permission methods — plus `FileSystemObserver`, which is newer than
 * all of it. Declared here rather than pulling in `@types/wicg-file-system-access`, which would
 * redeclare the halves `lib.dom` already has and conflict with them.
 *
 * Every one of these is feature-detected before use (`state/diskFolders.ts`): the whole folder
 * feature is absent on browsers without the API, which is most of them outside Chromium.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  /** Groups the picker's "last opened" memory — two pickers sharing an id reopen in the same place. */
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}

/**
 * One change to something being observed.
 *
 * For an observation rooted at a **file** — which is the only kind this app makes —
 * `relativePathComponents` is always empty and `root` is that file's handle. `errored` follows
 * `disappeared` when the observed file is deleted, and **ends the observation**: nothing further is
 * delivered, not even if the same path reappears. See `diskFolders.ts`'s watch, which re-arms.
 */
interface FileSystemChangeRecord {
  readonly root: FileSystemHandle;
  readonly changedHandle: FileSystemHandle | null;
  readonly relativePathComponents: readonly string[];
  readonly type: "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";
  readonly relativePathMovedFrom: readonly string[] | null;
}

interface FileSystemObserverObserveOptions {
  recursive?: boolean;
}

declare class FileSystemObserver {
  constructor(
    callback: (records: FileSystemChangeRecord[], observer: FileSystemObserver) => void,
  );
  observe(
    handle: FileSystemHandle,
    options?: FileSystemObserverObserveOptions,
  ): Promise<void>;
  unobserve(handle: FileSystemHandle): void;
  disconnect(): void;
}
