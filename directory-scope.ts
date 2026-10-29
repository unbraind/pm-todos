/** Kernel-anchored traversal for files whose authority is an already opened directory. */
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";

/** Safe transport refusal; no input path or native error is disclosed. */
export class DirectoryScopeError extends Error {
  /** Explain both unsafe entries and missing descriptor-relative filesystem support. */
  constructor() {
    super("Use ordinary single-link files and directories, without symbolic links, on a host with a kernel directory-descriptor view (Linux: mount procfs); retry with fresh review files.");
    this.name = "DirectoryScopeError";
  }
}
/** Resolve through a kernel descriptor view; never fall back to the directory's old pathname. */
export function directoryDescriptorPath(fd: number): string {
  let probe: number | undefined;
  try {
    if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw new DirectoryScopeError();
    const path = (process.platform === "linux" ? "/proc/self/fd/" : "/dev/fd/") + fd;
    const expected = fstatSync(fd);
    probe = openSync(path + "/.", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const actual = fstatSync(probe);
    if (!expected.isDirectory() || !actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new DirectoryScopeError();
    return path;
  } catch { throw new DirectoryScopeError(); }
  finally { if (probe !== undefined) closeSync(probe); }
}

/** One owned directory lifetime; callers close each returned file descriptor. */
export interface DirectoryScope {
  file: (file: string) => { open: (create?: boolean) => number };
  open: (file: string, create?: boolean) => number;
  close: () => void;
}
/** Hold every intermediate directory until the caller finishes all scoped file operations. */
export function openDirectoryScope(directory: string): DirectoryScope {
  const directories: number[] = [];
  let closed = false;
  /** Release only this scope's handles, once, after its file operations finish. */
  function close(): void {
    if (closed) return;
    closed = true;
    for (const fd of directories.reverse()) closeSync(fd);
  }
  /** Open and validate a directory relative to its retained parent descriptor. */
  function retain(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push(fd);
    return directoryDescriptorPath(fd);
  }
  try {
    const root = retain(directory);
    /** Resolve every parent before a caller starts creating any review output. */
    function file(name: string): { open: (create?: boolean) => number } {
      try {
        const parts = name.split("/");
        if (closed || !name || /[\\\u0000]/.test(name) || parts.some(part => !part || part === "." || part === "..")) throw new DirectoryScopeError();
        let parent = root;
        for (const part of parts.slice(0, -1)) parent = retain(join(parent, part));
        const path = join(parent, parts.at(-1)!);
        return {
          /** Use only the captured parent capability; refuse stale scopes and final links. */
          open(create = false) {
            let fd: number | undefined;
            try {
              if (closed) throw new DirectoryScopeError();
              fd = openSync(path, (create ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
              const stat = fstatSync(fd);
              if (!stat.isFile() || stat.nlink !== 1) throw new DirectoryScopeError();
              return fd;
            } catch { if (fd !== undefined) closeSync(fd); throw new DirectoryScopeError(); }
          },
        };
      } catch { throw new DirectoryScopeError(); }
    }
    return {
      file,
      /** Convenience read/create using the same prepared parent capability. */
      open(name, create = false) { return file(name).open(create); },
      close,
    };
  } catch { close(); throw new DirectoryScopeError(); }
}
