/**
 * The path the ADAPTER sees versus the path the OS sees.
 *
 * ── Why two shapes exist ─────────────────────────────────────────────────
 * `@ai-sdk/harness` and its adapters compose every path with POSIX string
 * operations — `posix.resolve`, `${dir}/.agent-runs/${id}`, `shellQuote` —
 * on every platform, because in their model the sandbox is a remote Linux
 * machine and the path is text sent over a wire. They never hand the value to
 * a native filesystem call themselves.
 *
 * That is exactly what makes a native Windows path fatal there: `posix.resolve`
 * does not recognise `C:\Users\…` as absolute, so it resolves it against the
 * process cwd and emits a hybrid — `/a/inspector/C:\Users\…\work/.harness-…` —
 * that the command translator then correctly refuses, because a backslash in
 * an operand is a shell escape on the platform the adapters were written for.
 *
 * The fix is NOT to teach the translator about backslashes. That check is a
 * security boundary and it is right as written. The fix is to give the adapter
 * what it was written for: a POSIX-shaped absolute path. On Windows the
 * session's roots are presented as `/c/Users/…` — the MSYS convention, which
 * is a bijection on drive-letter paths and is what Git Bash and `cygpath -u`
 * already print on that machine — and mapped back to the native path at the
 * ONE place every operand crosses into a real OS call, which is the
 * provider's `confine`.
 *
 * ── What this does not do ────────────────────────────────────────────────
 * It is not path normalisation and it is not confinement. `fromAdapterPath`
 * turns `/c/x` into `C:\x` and hands everything else back untouched, so a path
 * that was never one of ours is judged by `confinePath` against the session's
 * roots exactly as before. A UNC path (`\\server\share`) has no POSIX shape
 * this module is willing to invent, and `toAdapterPath` refuses it rather than
 * producing something the adapter would then feed back to us.
 *
 * On darwin and linux both functions are the identity.
 */
import { posix, win32 } from "node:path";

export class AdapterPathError extends Error {}

/** `/c/Users/x` — the MSYS spelling of `C:\Users\x`. */
const MSYS_DRIVE_PATH = /^\/([A-Za-z])(?:\/(.*))?$/;
/** `C:\Users\x` or `C:/Users/x`. */
const NATIVE_DRIVE_PATH = /^([A-Za-z]):[\\/]/;

/**
 * The POSIX-shaped path the adapter is given for a native path we own.
 *
 * Identity off Windows. On Windows the input must be a drive-letter absolute
 * path; the result is `/<drive>/<segments>` with forward slashes and no
 * trailing separator.
 */
export function toAdapterPath(
  nativePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return nativePath;
  const normalized = win32.normalize(nativePath);
  const drive = NATIVE_DRIVE_PATH.exec(normalized);
  if (drive === null) {
    // `\\server\share`, a relative path, or a bare `C:` with no separator. None
    // of these have a POSIX shape this module is willing to invent.
    throw new AdapterPathError(
      `cannot present ${JSON.stringify(nativePath)} to the adapter: only a ` +
        `drive-letter absolute path has a POSIX-shaped spelling`,
    );
  }
  const rest = normalized
    .slice(drive[0].length)
    .split(win32.sep)
    .filter((segment) => segment.length > 0)
    .join("/");
  return rest.length === 0
    ? `/${drive[1]!.toLowerCase()}`
    : `/${drive[1]!.toLowerCase()}/${rest}`;
}

/**
 * The native path behind an adapter-facing one.
 *
 * Identity off Windows. On Windows an MSYS drive path becomes the native
 * spelling; anything else is returned unchanged, so a path that is not one of
 * ours is still refused by confinement rather than reinterpreted here.
 */
export function fromAdapterPath(
  adapterPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return adapterPath;
  const match = MSYS_DRIVE_PATH.exec(adapterPath);
  if (match === null) return adapterPath;
  const drive = `${match[1]!.toUpperCase()}:`;
  const rest = match[2] ?? "";
  // `posix.normalize` first so `..` is resolved in the shape the adapter wrote
  // it, then re-seated on the drive. A path that climbs above the drive root
  // normalises to the root itself; it is confinement's job to refuse it.
  const normalizedRest = posix.normalize(`/${rest}`);
  return win32.normalize(`${drive}${normalizedRest}`);
}

/** Is this a path `fromAdapterPath` would translate on win32? */
export function isAdapterShapedWindowsPath(path: string): boolean {
  return MSYS_DRIVE_PATH.test(path);
}
