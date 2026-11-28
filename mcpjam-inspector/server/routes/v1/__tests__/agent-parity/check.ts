/**
 * The agent parity rules, as a pure function the test runs over the real
 * scan and over fixtures.
 *
 * A backend function the app names is accounted for when:
 * - a v1 route file names it (agents reach it through REST, the SDK, MCP and
 *   the CLI; other tests check each of those links), or
 * - `COVERED` names the operation that reaches the same capability through a
 *   different function, or
 * - `NOT_EXPOSED` records why agents should not have it, or
 * - it is in the backlog: undecided, from before this check existed.
 */

export type ParityInputs = {
  /** Backend function → app files that name it. */
  appCalls: ReadonlyMap<string, readonly string[]>;
  /** Backend functions a v1 route file names. */
  reachable: ReadonlySet<string>;
  covered: Readonly<Record<string, string>>;
  notExposed: Readonly<Record<string, string>>;
  notBackendPrefixes: Readonly<Record<string, string>>;
  backlog: readonly string[];
  backlogMax: number;
  operationNames: ReadonlySet<string>;
};

const MAP_FILE = "server/routes/v1/__tests__/agent-parity/map.ts";
const BACKLOG_FILE = "server/routes/v1/__tests__/agent-parity/backlog.json";
const MAX_REASON = 160;

const moduleOf = (name: string) => name.slice(0, name.indexOf(":"));

function explicitlyNotExposed(
  name: string,
  notExposed: ParityInputs["notExposed"],
): boolean {
  return name in notExposed || `${moduleOf(name)}:*` in notExposed;
}

/** Every rule broken, one message each. Empty when the map is current. */
export function checkParity(inputs: ParityInputs): string[] {
  const problems: string[] = [];
  const backlog = new Set(inputs.backlog);

  for (const [name, files] of inputs.appCalls) {
    if (
      inputs.reachable.has(name) ||
      name in inputs.covered ||
      explicitlyNotExposed(name, inputs.notExposed) ||
      backlog.has(name)
    ) {
      continue;
    }
    problems.push(
      `${name} (${files.join(", ")}): the app calls this backend function and no v1 route does, so agents cannot. ` +
        `Expose it (v1 route → SDK client method → operation → MCP and CLI bindings), or record it in ${MAP_FILE}: ` +
        `COVERED with the operation that already reaches the capability, or NOT_EXPOSED with a one-line reason.`,
    );
  }

  for (const [name, operation] of Object.entries(inputs.covered)) {
    if (!inputs.appCalls.has(name)) {
      problems.push(
        `COVERED ${name}: the app no longer calls it; delete the entry in ${MAP_FILE}.`,
      );
    }
    if (!inputs.operationNames.has(operation)) {
      problems.push(
        `COVERED ${name}: operation ${operation} is not in ALL_OPERATIONS; name an operation agents can call.`,
      );
    }
    if (inputs.reachable.has(name)) {
      problems.push(
        `COVERED ${name}: a v1 route already names it; delete the entry in ${MAP_FILE}.`,
      );
    }
  }

  for (const [key, reason] of Object.entries(inputs.notExposed)) {
    const used = key.endsWith(":*")
      ? [...inputs.appCalls.keys()].some(
          (name) => `${moduleOf(name)}:*` === key,
        )
      : inputs.appCalls.has(key);
    if (!used) {
      problems.push(
        `NOT_EXPOSED ${key}: the app no longer calls it; delete the entry in ${MAP_FILE}.`,
      );
    }
    if (reason.trim().length === 0 || reason.length > MAX_REASON) {
      problems.push(
        `NOT_EXPOSED ${key}: give a one-line reason of at most ${MAX_REASON} characters.`,
      );
    }
  }

  for (const [prefix, what] of Object.entries(inputs.notBackendPrefixes)) {
    if (what.trim().length === 0 || what.length > MAX_REASON) {
      problems.push(
        `NOT_BACKEND_PREFIXES ${prefix}: say what these strings are, in at most ${MAX_REASON} characters.`,
      );
    }
  }

  for (const name of inputs.backlog) {
    if (!inputs.appCalls.has(name)) {
      problems.push(
        `Backlog ${name}: the app no longer calls it; delete it from ${BACKLOG_FILE} and lower BACKLOG_MAX.`,
      );
    } else if (inputs.reachable.has(name)) {
      problems.push(
        `Backlog ${name}: a v1 route now names it, so agents can reach it; delete it from ${BACKLOG_FILE} and lower BACKLOG_MAX.`,
      );
    } else if (
      name in inputs.covered ||
      explicitlyNotExposed(name, inputs.notExposed)
    ) {
      problems.push(
        `Backlog ${name}: it is decided in ${MAP_FILE}; delete it from ${BACKLOG_FILE} and lower BACKLOG_MAX.`,
      );
    }
  }

  if (backlog.size !== inputs.backlog.length) {
    problems.push(`${BACKLOG_FILE} lists a function twice.`);
  }
  // Exact, not a ceiling: with `<=`, entries resolved later would leave room
  // for new ones to be added without touching the constant.
  if (inputs.backlog.length !== inputs.backlogMax) {
    problems.push(
      inputs.backlog.length > inputs.backlogMax
        ? `${BACKLOG_FILE} grew to ${inputs.backlog.length} entries (BACKLOG_MAX is ${inputs.backlogMax}). New app calls are decided now, not added to the backlog: expose the capability, or record it in ${MAP_FILE}.`
        : `${BACKLOG_FILE} has ${inputs.backlog.length} entries; lower BACKLOG_MAX in ${MAP_FILE} from ${inputs.backlogMax} to ${inputs.backlog.length}.`,
    );
  }

  return problems;
}
