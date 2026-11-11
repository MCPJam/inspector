/**
 * An in-memory box for the skill writer's tests: a file map, and the shell the
 * box writer and `@ai-sdk/harness`'s `writeSkills` send it (`mkdir -p`,
 * `mv -f`, `rm -rf --`, `rm -f --`, `test ! -e`, and the writer's `find`
 * sweeps). Paths arrive single-quoted. A command it doesn't know throws, so a
 * test notices when the writer starts sending a new one.
 */
import type { BoxSkillsSession } from "../../utils/harness/box-skills-writer.js";

export const BOX_HOME = "/home/user";

export interface FakeSkillBox {
  session: BoxSkillsSession;
  files: Map<string, string>;
  commands: string[];
  /** The skill folders (holding a SKILL.md) directly under `folder`. */
  skillFolders(folder: string): string[];
}

export function fakeSkillBox(
  options: {
    files?: Record<string, string>;
    /** A write to a path this returns true for fails. */
    failWrite?: (path: string) => boolean;
  } = {},
): FakeSkillBox {
  const files = new Map(Object.entries(options.files ?? {}));
  const dirs = new Set<string>();
  const commands: string[] = [];
  const ok = { exitCode: 0, stdout: "", stderr: "" };

  const tokens = (command: string): string[] =>
    [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  const under = (path: string) => (entry: string) =>
    entry === path || entry.startsWith(`${path}/`);
  const exists = (path: string) =>
    [...files.keys(), ...dirs].some(under(path));
  const removeTree = (path: string) => {
    for (const dir of [...dirs]) if (under(path)(dir)) dirs.delete(dir);
    for (const file of [...files.keys()]) if (under(path)(file)) files.delete(file);
  };
  const write = (path: string, content: string) => {
    if (options.failWrite?.(path)) throw new Error(`write refused: ${path}`);
    files.set(path, content);
  };

  const session: BoxSkillsSession = {
    readTextFile: async ({ path }) => files.get(path) ?? null,
    writeTextFile: async ({ path, content }) => write(path, content),
    writeBinaryFile: async ({ path, content }) =>
      write(path, Buffer.from(content).toString("utf8")),
    run: async ({ command }) => {
      commands.push(command);
      const argv = tokens(command);
      if (argv[0] === "mkdir" && argv[1] === "-p") {
        dirs.add(argv[2]!);
        return ok;
      }
      if (argv[0] === "mv" && argv[1] === "-f") {
        const content = files.get(argv[2]!);
        if (content === undefined) return { ...ok, exitCode: 1 };
        files.set(argv[3]!, content);
        files.delete(argv[2]!);
        return ok;
      }
      if (argv[0] === "rm" && argv[2] === "--") {
        for (const path of argv.slice(3)) removeTree(path);
        return ok;
      }
      if (argv[0] === "test" && argv[1] === "!" && argv[2] === "-e") {
        return { ...ok, exitCode: exists(argv[3]!) ? 1 : 0 };
      }
      if (argv[0] === "find" && argv.includes("-mindepth")) {
        const base = argv[1]!;
        if (!exists(base)) return { ...ok, exitCode: 1 };
        const found = [...files.keys()].filter(
          (path) =>
            path.startsWith(`${base}/`) &&
            path.slice(base.length + 1).includes("/") &&
            !path.endsWith("/SKILL.md"),
        );
        const sized = argv.includes("-printf");
        return {
          ...ok,
          stdout: found
            .map((path) =>
              sized ? `${Buffer.byteLength(files.get(path)!)}\t${path}` : path,
            )
            .join("\n"),
        };
      }
      throw new Error(`fake box: unknown command: ${command}`);
    },
  };

  return {
    session,
    files,
    commands,
    skillFolders: (folder) =>
      [...files.keys()]
        .filter(
          (path) =>
            path.startsWith(`${folder}/`) &&
            path.slice(folder.length + 1).split("/").length === 2 &&
            path.endsWith("/SKILL.md"),
        )
        .map((path) => path.slice(folder.length + 1).split("/")[0]!)
        .sort(),
  };
}
