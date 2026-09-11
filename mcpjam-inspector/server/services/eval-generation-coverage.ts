import type { ServerToolSnapshot } from "../utils/export-helpers";
import type { GeneratedTestCase } from "./eval-agent";

/** Unknown tools are not implicitly read-only. Keep server identities for attachment matching. */
export function readOnlyGenerationSnapshot(
  snapshot: ServerToolSnapshot,
): ServerToolSnapshot {
  // Unqualified tool names must not resolve to a write tool on another server.
  const ambiguous = new Set(
    snapshot.servers.flatMap((server) =>
      server.tools
        .filter((tool) => tool.annotations?.readOnlyHint !== true)
        .map((tool) => tool.name),
    ),
  );
  const servers = snapshot.servers.map((server) => ({
    ...server,
    tools: server.tools.filter(
      (tool) =>
        tool.annotations?.readOnlyHint === true && !ambiguous.has(tool.name),
    ),
  }));
  if (!servers.some((server) => server.tools.length)) {
    throw new Error(
      "No tools are marked read-only on these servers. Choose Read and write or add read-only tool annotations, then try again.",
    );
  }
  return { ...snapshot, servers };
}

/** Inspect all turns before the client reduces extra assertions. */
export function filterReadOnlyGeneratedCases(
  tests: GeneratedTestCase[],
  snapshot: ServerToolSnapshot,
) {
  const allowed = new Set(
    snapshot.servers.flatMap((server) => server.tools.map((tool) => tool.name)),
  );
  const result = tests.filter((test) => {
    const calls = [
      ...test.expectedToolCalls,
      ...(test.promptTurns ?? []).flatMap((turn) => turn.expectedToolCalls),
    ];
    if (!calls.every((call) => allowed.has(call.toolName))) return false;
    return (test.steps ?? []).every((step) => {
      if (step.kind === "toolCall") return allowed.has(step.toolName);
      // Widget interactions can mutate state even after a read-only render.
      if (step.kind === "interact") return false;
      if (step.kind !== "assert") return true;
      const assertion = step.assertion;
      if ("type" in assertion && assertion.type === "toolNeverCalled")
        return true;
      if ("toolName" in assertion)
        return (
          assertion.toolName === undefined || allowed.has(assertion.toolName)
        );
      if ("toolNames" in assertion)
        return assertion.toolNames.every((name) => allowed.has(name));
      return true;
    });
  });
  if (!result.length)
    throw new Error(
      "No read-only cases matched the selected scope. Try generating again or choose Read and write.",
    );
  return result;
}
