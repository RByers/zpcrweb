/**
 * GitHub repositories the app is reading files out of — the third kind of folder in the Files
 * view, after a folder on the user's disk (`state/diskFolders.ts`) and the bundled `samples`
 * (`lib/samples.ts`).
 *
 * This module owns *which* repositories the app knows about, what each is labelled, and the
 * one-directory-at-a-time listing cache over them; `lib/github.ts` owns the requests themselves and
 * `state/githubToken.ts` the token, if there is one.
 *
 * ## How a repository gets here
 *
 * Through the URL, and only through the URL: `#github=RByers/MolBioLab` (optionally
 * `owner/repo@branch`, and repeatable for more than one). The parameter is **consumed on arrival**
 * like `#load=` — read at module evaluation, stripped from the address bar, and remembered in
 * `localStorage` — so the repository is a folder this browser has from then on, removable with the
 * ✕ in the Files view exactly like a folder on disk. That is what makes the *other* half of such a
 * link work: `#github=owner/repo&file=runs/a.zpcr` names a file relative to the repository, and
 * after the file opens the app rewrites the hash to the file's own full name
 * (`useZpcrStore`'s `openNamedFile`), which still resolves on the next reload because the repo is
 * still here.
 *
 * ## A repository is a folder, with three differences
 *
 * **The label is `owner/repo`** — with `@ref` when the link pinned a branch, tag or commit — rather
 * than a bare directory name. It is the first component of every file name beneath it
 * (`RByers/MolBioLab/runs/a.zpcr`), which makes a name say where the file came from, and it cannot
 * collide with a folder on disk, whose label is one directory name and so never contains a `/`.
 *
 * **There is no permission to grant.** A public repo needs nothing; a private one needs the token,
 * and a missing or expired token surfaces as the failed listing it is, with the reason said out
 * loud (`lib/github.ts`'s `describeFailure`).
 *
 * **What you open is a copy**, as with a bundled sample: this app cannot commit, so an edit is
 * never written back. Everything else — the checkbox that opens a file, the folder-rooted name, the
 * type chips, the ↻ — is the same folder UI doing the same thing.
 *
 * ## Nothing is walked
 *
 * The same promise `diskFolders.ts` makes. One directory level per {@link listGithubDirectory},
 * cached until {@link invalidateGithubListings}, and the tree calls it as the user opens nodes. The
 * Git trees API would fetch a whole repository in one request; it is deliberately not used, because
 * a repository is somebody's entire history and the app only ever needs the directory in front of
 * the user — and because 60 anonymous requests an hour go a lot further when each one is a
 * directory somebody actually looked at.
 */

import { matchesSupportedExtension } from "@zpcrweb/core";
import {
  fetchRepoFile,
  formatRepoSpec,
  listRepoDirectory,
  parseRepoSpec,
  type RepoRef,
} from "../lib/github";
import { currentGithubToken } from "./githubToken";
import type { DiskEntry } from "./diskFolders";

/** One repository the app is reading, as the Files view lists it. */
export interface GithubFolder {
  /** `owner/repo`, or `owner/repo@ref` — the folder's name in the Files view, and the first
   * component of every file name in it. */
  label: string;
  repo: RepoRef;
  addedAt: number;
}

/** Where a file inside a repository is: which folder, and the path within it. Mirrors
 * `db.ts`'s `DiskSource`, which is the same idea for a folder on disk. */
export interface GithubSource {
  folder: string;
  path: readonly string[];
}

const STORAGE_KEY = "zpcr:githubRepos";
const HASH_PARAM = "github";

/** Label → repository. Read from `localStorage` at module evaluation, then authoritative. */
const repos = new Map<string, GithubFolder>();

interface StoredRepo {
  label: string;
  owner: string;
  repo: string;
  ref?: string;
  addedAt: number;
}

function load(): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore (private mode, etc.) — the app runs with no remembered repositories */
  }
  if (!raw) return;
  try {
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return;
    for (const item of stored as StoredRepo[]) {
      if (typeof item?.label !== "string" || typeof item.owner !== "string") continue;
      if (typeof item.repo !== "string") continue;
      repos.set(item.label, {
        label: item.label,
        repo: item.ref ? { owner: item.owner, repo: item.repo, ref: item.ref } : { owner: item.owner, repo: item.repo },
        addedAt: typeof item.addedAt === "number" ? item.addedAt : 0,
      });
    }
  } catch {
    /* a corrupt value is one nobody can act on: start empty rather than fail to boot */
  }
}

function save(): void {
  try {
    const stored: StoredRepo[] = [...repos.values()].map((f) => ({
      label: f.label,
      owner: f.repo.owner,
      repo: f.repo.repo,
      ...(f.repo.ref ? { ref: f.repo.ref } : {}),
      addedAt: f.addedAt,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* ignore storage failures — the repositories still work for this page load */
  }
}

load();

/**
 * Add a repository by its `owner/repo[@ref]` spec, or return the one already here under that label.
 * `null` if the spec isn't a repository name.
 *
 * The label *is* the spec, which is what makes this idempotent: the same link followed twice adds
 * one folder, and `owner/repo` and `owner/repo@branch` are two folders because they are two
 * different sets of bytes.
 */
export function addGithubRepo(spec: string): GithubFolder | null {
  const repo = parseRepoSpec(spec);
  if (!repo) return null;
  const label = formatRepoSpec(repo);
  const existing = repos.get(label);
  if (existing) return existing;
  const folder: GithubFolder = { label, repo, addedAt: Date.now() };
  repos.set(label, folder);
  save();
  return folder;
}

/** Stop reading a repository. Nothing on GitHub is touched, and files already opened out of it
 * stay open — they are copies in this browser, and were from the moment they were opened. */
export function removeGithubRepo(label: string): void {
  repos.delete(label);
  for (const key of [...listings.keys()]) if (keyFolder(key) === label) listings.delete(key);
  save();
}

/** The repositories, oldest first — the order the Files view lists them in, matching the disk
 * folders above them. */
export function listGithubFolders(): GithubFolder[] {
  return [...repos.values()].sort((a, b) => a.addedAt - b.addedAt);
}

/** The repository a label names, if the app is reading one. */
export function getGithubFolder(label: string): GithubFolder | undefined {
  return repos.get(label);
}

/** Whether a label is a repository's rather than a disk folder's or the bundled samples'. */
export function isGithubFolder(label: string): boolean {
  return repos.has(label);
}

/** What the app calls a file in a repository — the folder's label and the path under it, joined
 * the way a disk-backed file's name is (`db.ts`'s `diskFileName`). */
export function githubFileName(source: GithubSource): string {
  return [source.folder, ...source.path].join("/");
}

// ── Listing, one level at a time ─────────────────────────────────────────────────────────

const listings = new Map<string, DiskEntry[]>();
/** Listings in flight, so a node that is both expanded and selected by one click is read once —
 * the same coalescing `diskFolders.ts` does, for the same reason. */
const inFlight = new Map<string, Promise<DiskEntry[]>>();

const cacheKey = (label: string, path: readonly string[]): string => JSON.stringify([label, ...path]);
const keyFolder = (key: string): string => (JSON.parse(key) as string[])[0]!;

/**
 * One directory of a repository: its subdirectories, and the files in it the app could open.
 *
 * Exactly one level, cached until {@link invalidateGithubListings}. Files are filtered by name, by
 * the same rule a disk listing uses, so a repository of notebooks and scripts shows only the runs,
 * plates and protocols in it.
 */
export async function listGithubDirectory(
  label: string,
  path: readonly string[],
): Promise<DiskEntry[]> {
  const key = cacheKey(label, path);
  const cached = listings.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const read = readGithubDirectory(label, path, key).finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

async function readGithubDirectory(
  label: string,
  path: readonly string[],
  key: string,
): Promise<DiskEntry[]> {
  const folder = repos.get(label);
  if (!folder) throw new Error(`no repository named ${label} — it may have been removed`);
  const entries = await listRepoDirectory(folder.repo, path, currentGithubToken());
  const usable: DiskEntry[] = entries
    .filter((e) => e.kind === "directory" || matchesSupportedExtension(e.name))
    .map((e) =>
      e.kind === "directory"
        ? { name: e.name, kind: "directory" as const }
        : { name: e.name, kind: "file" as const, size: e.size },
    );
  listings.set(key, usable);
  return usable;
}

/** Drop cached listings so the next {@link listGithubDirectory} asks GitHub again — what the ↻
 * button and a re-opened Files view call. With no `label`, drops everything. */
export function invalidateGithubListings(label?: string): void {
  if (label === undefined) listings.clear();
  else for (const key of [...listings.keys()]) if (keyFolder(key) === label) listings.delete(key);
}

/** Whether a file of this name is in the directory the name points at. What a `#file=` link is
 * checked against before the app claims to have found it. */
export async function githubFileExists(source: GithubSource): Promise<boolean> {
  const listing = await listGithubDirectory(source.folder, source.path.slice(0, -1));
  return listing.some((e) => e.kind === "file" && e.name === source.path.at(-1));
}

/** One file's bytes, straight from the repository. */
export async function readGithubFile(source: GithubSource): Promise<Uint8Array> {
  const folder = repos.get(source.folder);
  if (!folder) throw new Error(`no repository named ${source.folder} — it may have been removed`);
  return fetchRepoFile(folder.repo, source.path, currentGithubToken());
}

// ── The `#github=` link ──────────────────────────────────────────────────────────────────

/**
 * Read `#github=` out of the hash and remember what it names, then strip it — at module
 * evaluation, for the same ordering reason `githubToken.ts` and `pltdPassword.ts` do it there: the
 * app's first hash rewrite is built from file/view alone and would otherwise drop the parameter
 * before anything had read it.
 *
 * Repeatable, so one link can carry more than one repository. A spec that isn't `owner/repo` is
 * dropped rather than reported: the rest of the link — the file it names — will fail to resolve on
 * its own, and say so in the one place that can, the file it couldn't open.
 */
try {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const specs = hash.getAll(HASH_PARAM);
  if (specs.length > 0) {
    for (const spec of specs) addGithubRepo(spec);
    hash.delete(HASH_PARAM);
    const h = hash.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${h ? `#${h}` : ""}`,
    );
  }
} catch {
  /* ignore (malformed URL, history quota) */
}
