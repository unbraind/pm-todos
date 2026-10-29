/** Confine public-corpus validation reads and permission changes to verified ordinary entries. */
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { directoryDescriptorPath, DirectoryScopeError } from "../directory-scope.ts";

/** Paths label entries only; filesystem operations use retained descriptors or parent anchors. */
interface Entry { path: string; fd: number; stat: Stats }
/** The session copy and its fingerprint must exclude exactly the same generated directories. */
export const VALIDATION_CACHE_NAMES = ["runtime", "locks", "search", "extensions"];

/** Refuse unsafe entries without disclosing their paths or opening their targets. */
function unsafe(): never {
  throw new Error("unsafe_validation_entry: use at most 10000 ordinary directories and single-link regular files; remove links and special files, and use a host with a kernel directory-descriptor view (Linux: mount procfs).");
}
/** Open a bounded tree once, without following final links; retain identity-bound descriptors. */
function openTree(root: string, excluded: readonly string[] = []): Entry[] {
  const entries: Entry[] = [];
  /** Verify entry type and identity before traversing or reading its contents. */
  function visit(lookup: string, path: string, directory = false): void {
    const expected = lstatSync(lookup);
    if ((!expected.isFile() && !expected.isDirectory()) || (directory && !expected.isDirectory()) || (expected.isFile() && expected.nlink !== 1) || entries.length >= 10000 || !constants.O_NOFOLLOW) unsafe();
    const fd = openSync(lookup, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = { path, fd, stat: expected };
    entries.push(opened);
    const stat = fstatSync(fd);
    opened.stat = stat;
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.isDirectory() !== expected.isDirectory() || (stat.isFile() && stat.nlink !== 1)) unsafe();
    if (stat.isDirectory()) {
      const anchor = directoryDescriptorPath(fd);
      for (const entry of readdirSync(anchor, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!excluded.includes(entry.name)) visit(join(anchor, entry.name), join(path, entry.name));
      }
      const current = lstatSync(lookup);
      if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isDirectory()) unsafe();
    }
  }
  try { visit(root, root, true); return entries; }
  catch (error) {
    for (const entry of entries) closeSync(entry.fd);
    if (error instanceof DirectoryScopeError || (error instanceof Error && "code" in error && ["ELOOP", "ENOENT", "ENOTDIR", "ESTALE"].includes(String(error.code)))) unsafe();
    throw error;
  }
}
/** Fingerprint verified paths and bytes, never dereferencing a link or blocking on a FIFO. */
export function fingerprintValidationTree(root: string, excluded: readonly string[] = []): { digest: string; files: number } {
  const entries = openTree(root, excluded), hash = createHash("sha256");
  let files = 0;
  try {
    for (const entry of entries) {
      hash.update(JSON.stringify([relative(root, entry.path), entry.stat.isDirectory() ? "directory" : "file"]));
      if (entry.stat.isFile()) { hash.update(readFileSync(entry.fd)); files++; }
    }
    return { digest: hash.digest("hex"), files };
  } finally { for (const entry of entries) closeSync(entry.fd); }
}
/** Copy verified descriptors into a fresh private tree, never reopening source ancestor pathnames. */
export function copyValidationTree(source: string, destination: string, excluded: readonly string[] = []): void {
  const entries = openTree(source, excluded), directories = new Map<string, number>();
  try {
    mkdirSync(destination, { mode: 0o700 });
    directories.set("", openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    for (const entry of entries.slice(1)) {
      const name = relative(source, entry.path), parent = directories.get(dirname(name) === "." ? "" : dirname(name));
      if (parent === undefined) unsafe();
      const path = join(directoryDescriptorPath(parent), basename(name));
      if (entry.stat.isDirectory()) {
        mkdirSync(path, { mode: 0o700 });
        directories.set(name, openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      } else {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600 | (entry.stat.mode & 0o100));
        try { writeFileSync(fd, readFileSync(entry.fd)); } finally { closeSync(fd); }
      }
    }
  } finally { for (const fd of [...directories.values()].reverse()) closeSync(fd); for (const entry of entries) closeSync(entry.fd); }
}
/** Freeze a fully verified disposable copy; restore exact modes using only retained descriptors. */
export function readonlyValidationTree(root: string): () => void {
  const entries = openTree(root);
  let restored = false;
  /** Release only entries opened by this guard, even if paths are replaced during validation. */
  function restore(): void {
    if (restored) return;
    restored = true;
    const errors: unknown[] = [];
    for (const entry of entries) {
      try { fchmodSync(entry.fd, entry.stat.mode & 0o7777); } catch (error) { errors.push(error); }
    }
    for (const entry of entries) {
      try { closeSync(entry.fd); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "validation_permission_restore_failed: inspect the disposable copy; every retained descriptor was released.");
  }
  try {
    for (const entry of [...entries].reverse()) fchmodSync(entry.fd, entry.stat.isDirectory() ? 0o555 : 0o444);
    return restore;
  } catch (error) { restore(); throw error; }
}
