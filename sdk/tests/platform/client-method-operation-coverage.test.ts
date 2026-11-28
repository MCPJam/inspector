/**
 * Every public `PlatformApiClient` method is reachable by agents: some SDK
 * module outside the client classes calls it (an operation, or a helper an
 * operation composes), or it is listed below with the reason it is not.
 *
 * Route coverage (`sdk-coverage.test.ts` in the Inspector) proves each v1
 * route has a client method, and the MCP and CLI partitions prove each
 * operation has a binding. This closes the link between them: without it,
 * `requestEvalRunInsights` had a route and a client method for months and no
 * operation, so no MCP tool and no CLI command could reach it.
 *
 * A name match, not a call graph: a method called anywhere in `sdk/src`
 * outside the client classes counts. That keeps methods an operation reaches
 * through a shared helper (`getEvalRunDecisionSummary`) covered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SDK_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src"
);
const PLATFORM_DIR = join(SDK_SRC, "platform");

/** Methods no operation calls, each with why. Remove an entry when an
 * operation starts calling the method; the test fails until you do. */
const CLIENT_METHODS_WITHOUT_OPERATION: Readonly<Record<string, string>> = {
  browserSession:
    "CLI only: `mcpjam browser` drives a browser session directly; agents use the chat session browser operations.",
  syncFileOwnedEvalSuite:
    "CLI only: `cloud eval run --file` syncs a suite from a local file, which an agent tool has no file system to read.",
  getEvalRunRerunPreview:
    "Backlog (eval authoring): `cloud eval rerun` calls it directly; no operation yet.",
  rerunEvalRun:
    "Backlog (eval authoring): `cloud eval rerun` calls it directly; no operation yet.",
  testEvalCodeEvaluator:
    "Backlog (code evaluators): the test_eval_code_evaluator operation lands with its MCP tool and CLI command, stacked on the route.",
  listEvalDescriptionExperimentsForRun:
    "Backlog (eval analyzers): get_eval_description_experiment reads one experiment by id; no operation lists a run's experiments yet.",
  getSpendBudget:
    "Backlog (org, billing and keys): spend budgets are organization billing settings; no operation yet.",
  setSpendBudget:
    "Backlog (org, billing and keys): spend budgets are organization billing settings; no operation yet.",
  clearSpendBudget:
    "Backlog (org, billing and keys): spend budgets are organization billing settings; no operation yet.",
  createServerWidgetSession:
    "Local Inspector only (hosted answers 404); render_server_widget covers one-shot rendering.",
  getServerWidgetSessionSnapshot:
    "Local Inspector only, with createServerWidgetSession.",
  executeServerWidgetSessionAction:
    "Local Inspector only, with createServerWidgetSession.",
  executeServerWidgetSessionStep:
    "Local Inspector only, with createServerWidgetSession.",
  closeServerWidgetSession:
    "Local Inspector only, with createServerWidgetSession.",
  retryServerConnectionValidation:
    "Backlog (servers): connect_project_server and its status read cover the flow; no operation asks for an early retry yet.",
  getDirectorySubmissionSnapshots:
    "Backlog (directory): no operation reads submission snapshots yet.",
  publishUserTestingScenario:
    "Deprecated duplicate of publishStudy, which publish_study calls.",
  withApiVocabulary:
    "Returns a client configured for a vocabulary version; it calls no route.",
  withEvalVocabulary:
    "Returns a client configured for a vocabulary version; it calls no route.",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

const isClientFile = (path: string) =>
  /(^|\/)(client|[a-z-]+-client)\.ts$/.test(relative(PLATFORM_DIR, path));

/** Public methods declared on the client classes `PlatformApiClient` extends. */
function publicClientMethods(): Set<string> {
  const names = new Set<string>();
  for (const path of sourceFiles(PLATFORM_DIR).filter(isClientFile)) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    file.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) {
          continue;
        }
        const hidden =
          ts.getCombinedModifierFlags(member).valueOf() &
          (ts.ModifierFlags.Private |
            ts.ModifierFlags.Protected |
            ts.ModifierFlags.Static);
        if (!hidden) names.add(member.name.text);
      }
    });
  }
  return names;
}

function calledOutsideClient(): string {
  return sourceFiles(SDK_SRC)
    .filter((path) => !isClientFile(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

describe("client method → operation coverage", () => {
  const methods = publicClientMethods();
  const callers = calledOutsideClient();
  const isCalled = (name: string) => new RegExp(`[.?]${name}\\(`).test(callers);

  it("finds the client's methods", () => {
    // A parse that silently found nothing would pass every check below.
    expect(methods.size).toBeGreaterThan(200);
    expect(methods.has("requestEvalRunInsights")).toBe(true);
  });

  it("reaches every public client method from an operation, or says why not", () => {
    const missing = [...methods]
      .filter((name) => !isCalled(name))
      .filter((name) => !(name in CLIENT_METHODS_WITHOUT_OPERATION))
      .sort();
    expect(
      missing,
      "Each client method needs an operation that calls it (add one in an " +
        "`sdk/src/platform/*operations*.ts` module, then bind it in " +
        "mcp/src/tools/platformTools.ts and cli/src/lib/op-bindings.ts), or " +
        "an entry with a reason in CLIENT_METHODS_WITHOUT_OPERATION in this file."
    ).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    const stale = Object.keys(CLIENT_METHODS_WITHOUT_OPERATION)
      .filter((name) => !methods.has(name) || isCalled(name))
      .sort();
    expect(
      stale,
      "These methods were removed or are now called by an operation; delete " +
        "their CLIENT_METHODS_WITHOUT_OPERATION entries."
    ).toEqual([]);
  });
});
