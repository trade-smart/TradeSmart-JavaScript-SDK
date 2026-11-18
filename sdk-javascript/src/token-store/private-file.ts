// The hardened file operations shared by the token file and the saved-keys file: an atomic
// private write (directory 0700, temp file created exclusively with mode 0600, fsync, rename) and
// a private read (one open file: owner and mode are checked on that handle and the text is read
// from it). Messages name the file, never its contents.
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import nodePath from "node:path";

/** Test seam for the file operations of the writer. */
export interface WriteHooks {
  rename?: (from: string, to: string) => Promise<void> | void;
}

/** Write `payload` to `path` atomically; no partial file is left on failure (rethrown). */
export async function writePrivateFile(
  path: string,
  payload: string,
  hooks: WriteHooks = {},
): Promise<void> {
  const dir = nodePath.dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = nodePath.join(
    dir,
    `.${nodePath.basename(path)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      // Explicit mode whatever the umask (a no-op for the mode bits on Windows).
      await handle.chmod(0o600);
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await (hooks.rename ?? rename)(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** The POSIX owner and mode check; `null` when the file is fine (always on Windows). */
export function privacyProblem(
  what: string,
  where: string,
  uid: number,
  mode: number,
): string | null {
  if (process.platform === "win32" || typeof process.geteuid !== "function") return null;
  if (uid !== process.geteuid()) {
    return `the ${what} at ${where} is owned by another user; delete it and log in again`;
  }
  if ((mode & 0o077) !== 0) {
    return (
      `the ${what} at ${where} has unsafe permissions (group or others can access it); ` +
      "delete it and log in again, or restrict it with chmod 600"
    );
  }
  return null;
}

/**
 * Read the UTF-8 text at `path` from one open handle after the owner/mode check. `null` when
 * there is no file; every other problem throws `fail(message)`.
 */
export function readPrivateText(
  path: string,
  what: string,
  fail: (message: string) => Error,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw fail(`the ${what} at ${path} cannot be read`);
  }
  try {
    let info;
    try {
      info = fstatSync(fd);
    } catch {
      throw fail(`the ${what} at ${path} cannot be read`);
    }
    if (!info.isFile()) throw fail(`the ${what} at ${path} cannot be read`);
    const problem = privacyProblem(what, path, info.uid, info.mode);
    if (problem !== null) throw fail(problem);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
    } catch {
      throw fail(`the ${what} at ${path} cannot be read`);
    }
  } finally {
    closeSync(fd);
  }
}
