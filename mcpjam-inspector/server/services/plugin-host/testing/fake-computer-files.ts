import type { ComputerFileSystem } from "../computer-file-target.js";

/** In-memory stand-in for the E2B sandbox filesystem used by Computer file
 * targets. `symlinks` and `dirs` mark paths the adapter must refuse. */
export function fakeComputerFiles(initial: Record<string, string> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, text]) => [
      path,
      new TextEncoder().encode(text),
    ]),
  );
  const symlinks = new Set<string>();
  const dirs = new Set<string>();
  const notFound = () =>
    Object.assign(new Error("file not found"), { name: "NotFoundError" });
  const calls: string[] = [];
  const fs: ComputerFileSystem & {
    files: typeof files;
    symlinks: typeof symlinks;
    dirs: typeof dirs;
    calls: typeof calls;
    beforeRename?: () => void;
  } = {
    files,
    symlinks,
    dirs,
    calls,
    async getInfo(path) {
      calls.push(`getInfo ${path}`);
      if (dirs.has(path)) return { type: "dir", size: 0 };
      const bytes = files.get(path);
      if (!bytes) throw notFound();
      return {
        type: "file",
        size: bytes.byteLength,
        ...(symlinks.has(path) ? { symlinkTarget: "/etc/passwd" } : {}),
      };
    },
    async read(path) {
      calls.push(`read ${path}`);
      const bytes = files.get(path);
      if (!bytes) throw notFound();
      return bytes.slice();
    },
    async write(path, data) {
      calls.push(`write ${path}`);
      files.set(path, new Uint8Array(data.slice(0)));
    },
    async rename(from, to) {
      calls.push(`rename ${from} ${to}`);
      fs.beforeRename?.();
      const bytes = files.get(from);
      if (!bytes) throw notFound();
      files.delete(from);
      files.set(to, bytes);
    },
    async remove(path) {
      calls.push(`remove ${path}`);
      // Folders: remove every file underneath, like the sandbox API.
      let removed = files.delete(path) || dirs.delete(path);
      for (const key of [...files.keys(), ...dirs])
        if (key.startsWith(`${path}/`)) {
          files.delete(key);
          dirs.delete(key);
          removed = true;
        }
      if (!removed) throw notFound();
    },
    async makeDir(path) {
      calls.push(`makeDir ${path}`);
      dirs.add(path);
      return true;
    },
    async list(path) {
      calls.push(`list ${path}`);
      const names = new Map<string, string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (!key.startsWith(`${path}/`)) continue;
        const [name, ...rest] = key.slice(path.length + 1).split("/");
        if (!names.has(name!))
          names.set(name!, rest.length || dirs.has(key) ? "dir" : "file");
      }
      if (!names.size && !dirs.has(path)) throw notFound();
      return [...names].map(([name, type]) => ({ name, type }));
    },
  };
  return fs;
}
