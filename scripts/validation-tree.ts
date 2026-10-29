/** Confine public-corpus validation reads and permission changes to verified ordinary entries. */
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { join, relative } from "node:path";

interface Entry { path: string; fd: number; stat: Stats }
/** The session copy and its fingerprint must exclude exactly the same generated directories. */
export const VALIDATION_CACHE_NAMES = ["runtime", "locks", "search", "extensions"];

/** Refuse unsafe entries without disclosing their paths or opening their targets. */
function unsafe(): never {
  throw new Error("unsafe_validation_entry: use at most 10000 ordinary directories and single-link regular files on a host supporting O_NOFOLLOW; remove symbolic links and special files from the validation input.");
}
/** Open a bounded tree once, without following final links; retain identity-bound descriptors. */
function openTree(root: string, excluded: readonly string[] = []): Entry[] {
  const entries: Entry[] = [];
  /** Verify entry type and identity before traversing or reading its contents. */
  function visit(path: string, directory = false): void {
    const expected = lstatSync(path);
    if ((!expected.isFile() && !expected.isDirectory()) || (directory && !expected.isDirectory()) || (expected.isFile() && expected.nlink !== 1) || entries.length >= 10000 || !constants.O_NOFOLLOW) unsafe();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = { path, fd, stat: expected };
    entries.push(opened);
    const stat = fstatSync(fd);
    opened.stat = stat;
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.isDirectory() !== expected.isDirectory() || (stat.isFile() && stat.nlink !== 1)) unsafe();
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!excluded.includes(entry.name)) visit(join(path, entry.name));
      }
      const current = lstatSync(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isDirectory()) unsafe();
    }
  }
  try { visit(root, true); return entries; }
  catch (error) { for (const entry of entries) closeSync(entry.fd); throw error; }
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
