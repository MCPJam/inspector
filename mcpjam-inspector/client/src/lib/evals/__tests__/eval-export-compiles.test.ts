import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { SDK_EVAL_QUICKSTART_RUN } from "@/components/evals/sdk-eval-quickstart";
import {
  buildSdkTestFile,
  buildServerConnections,
  normalizeEvalCaseForExport,
} from "@/lib/evals/eval-export";

/**
 * The export modal hands users a file to run. Every other test in this folder
 * asserts on the emitted STRING, which cannot tell a live SDK symbol from a
 * retired one — that blind spot is why the generator kept emitting `TestAgent`
 * and `.prompt()` for the whole 1.11 → 8.x window after the SDK removed both
 * without aliases.
 *
 * So this test compiles the emitted file against the SDK's real source. It is
 * slower than a string match by design: a rename that the generator does not
 * follow has to fail HERE rather than in a user's terminal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// client/src/lib/evals/__tests__ → …/client → …/mcpjam-inspector → repo root
const SDK_ENTRY = resolve(HERE, "../../../../../../sdk/src/index.ts");

const httpServer = {
  name: "mcpjam",
  config: { url: new URL("https://mcp.mcpjam.com/mcp") },
} as never;

function exportFor(testCase: Record<string, unknown>): string {
  return buildSdkTestFile({
    suite: { name: "compile fixture", description: "compile fixture" },
    cases: [normalizeEvalCaseForExport(testCase as never)],
    serverConnections: buildServerConnections(["mcpjam"], {
      mcpjam: httpServer,
    }),
  });
}

const SINGLE_TURN = exportFor({
  _id: "c_single",
  title: "single turn",
  query: "list my projects",
  runs: 1,
  isNegativeTest: false,
  steps: [
    { id: "s1", kind: "prompt", prompt: "list my projects" },
    {
      id: "s2",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "list_projects",
        args: { args: { limit: 10 } },
      },
    },
  ],
});

const MULTI_TURN = exportFor({
  _id: "c_multi",
  title: "multi turn",
  query: "list my projects",
  runs: 2,
  isNegativeTest: false,
  steps: [
    { id: "s1", kind: "prompt", prompt: "list my projects" },
    {
      id: "s2",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "list_projects",
        args: { args: { limit: 10 } },
      },
    },
    { id: "s3", kind: "prompt", prompt: "now open the first one" },
    {
      id: "s4",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "get_project",
        args: { args: {} },
      },
    },
  ],
});

/**
 * A case with NO turns. `buildSdkTestFile` is exported, and its multi-turn
 * branch is the `else` of `promptTurns.length === 1` — so it renders
 * `ExportedTurn[]` here too, and the declaration guard has to agree.
 */
const EMPTY_TURNS = buildSdkTestFile({
  suite: { name: "empty", description: "" },
  cases: [
    {
      id: "c_empty",
      title: "no turns",
      query: "",
      runs: 1,
      isNegativeTest: false,
      expectedToolCalls: [],
      promptTurns: [],
    },
  ],
  serverConnections: buildServerConnections(["mcpjam"], { mcpjam: httpServer }),
});

/**
 * Free text and tool names come from outside this codebase — an MCP server
 * names its own tools — so a line terminator in either must not be able to
 * close a generated comment and turn the rest into code.
 */
const INJECTION_MARKER = "INJECTED_BY_FIXTURE";
const INJECTION = exportFor({
  _id: "c_inject",
  title: "injection",
  query: "hi",
  runs: 1,
  isNegativeTest: false,
  scenario: `line one\n      throw new Error("${INJECTION_MARKER}");`,
  steps: [
    { id: "s1", kind: "prompt", prompt: "hi" },
    {
      id: "s2",
      kind: "toolCall",
      serverName: "mcpjam",
      toolName: `evil\u2028      throw new Error("${INJECTION_MARKER}");`,
      arguments: {},
    },
  ],
});

const NEGATIVE = exportFor({
  _id: "c_negative",
  title: "negative",
  query: "just chat",
  runs: 1,
  isNegativeTest: true,
  steps: [{ id: "s1", kind: "prompt", prompt: "just chat" }],
});

/**
 * Compile `files` against the SDK source and return readable diagnostics.
 *
 * The sources are VIRTUAL but addressed inside this directory, so `vitest` and
 * the workspace `node_modules` resolve exactly as they would for a real file
 * here; only `@mcpjam/sdk` is mapped explicitly, because the package advertises
 * `./dist` and a clean checkout has not built it.
 */
function typecheck(files: Record<string, string>): string[] {
  const virtualFiles = new Map<string, string>();
  for (const [name, contents] of Object.entries(files)) {
    virtualFiles.set(join(HERE, name), contents);
  }
  // The SDK's `skill-reference.ts` raw-imports markdown, which only the SDK's
  // own bundler config declares. Shim it so those imports resolve here.
  virtualFiles.set(
    join(HERE, "__md-shim.d.ts"),
    'declare module "*.md" { const content: string; export default content; }\n'
  );

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    resolveJsonModule: true,
    baseUrl: HERE,
    paths: { "@mcpjam/sdk": [SDK_ENTRY] },
  };

  const host = ts.createCompilerHost(options, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const virtual = virtualFiles.get(fileName);
    return virtual === undefined
      ? realGetSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, virtual, languageVersion, true);
  };
  host.fileExists = (fileName) =>
    virtualFiles.has(fileName) || realFileExists(fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? realReadFile(fileName);

  const program = ts.createProgram([...virtualFiles.keys()], options, host);
  const owned = new Set(virtualFiles.keys());

  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && owned.has(diagnostic.file.fileName))
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      const { line } = diagnostic.file!.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0
      );
      const name = diagnostic.file!.fileName.split("/").pop();
      return `${name}:${line + 1} TS${diagnostic.code}: ${message}`;
    });
}

describe("exported SDK test files compile against the real SDK", () => {
  it(
    "emits only live SDK symbols for single-turn, multi-turn and negative cases",
    () => {
      expect(
        typecheck({
          "single.test.ts": SINGLE_TURN,
          "multi.test.ts": MULTI_TURN,
          "negative.test.ts": NEGATIVE,
          "empty.test.ts": EMPTY_TURNS,
        })
      ).toEqual([]);
    },
    120_000
  );

  it(
    "keeps the in-app quickstart snippet compiling",
    () => {
      expect(typecheck({ "quickstart.test.ts": SDK_EVAL_QUICKSTART_RUN })).toEqual(
        []
      );
    },
    120_000
  );

  it("cannot be made to emit code through a comment", () => {
    // Compiling is necessary but not sufficient: injected source could compile
    // fine and still run. Every line mentioning the payload must be a comment.
    expect(typecheck({ "injection.test.ts": INJECTION })).toEqual([]);

    // Split on the SAME terminator set the generator splits on. Splitting on
    // "\n" alone would miss this fixture's own vector: a U+2028 inside a tool
    // name is a line terminator to TypeScript but not to String.split("\n"),
    // so a regression that stopped splitting on it would leave
    // `// ...evil\u2028throw ...` looking like one comment line here AND
    // compiling cleanly — both checks green with the injection live.
    const offending = INJECTION.split(/[\r\n\u2028\u2029]/).filter(
      (line) => line.includes(INJECTION_MARKER) && !line.trim().startsWith("//")
    );
    expect(offending).toEqual([]);
  });

  it("pins the executor surface the generator depends on", () => {
    // A rename on either of these is what broke the export before; name them
    // explicitly so the failure message points at the rename, not at a wall of
    // compiler output.
    for (const emitted of [SINGLE_TURN, MULTI_TURN, NEGATIVE]) {
      expect(emitted).toContain("HostRunner");
      expect(emitted).toContain("agent.run(");
      expect(emitted).not.toContain("TestAgent");
      expect(emitted).not.toContain("agent.prompt(");
    }
  });
});
