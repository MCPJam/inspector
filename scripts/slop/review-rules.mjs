/**
 * Ratchet rules for bug classes that reviewers kept flagging on inspector PRs
 * and that the syntax tree can find with few false positives. `rules.mjs`
 * spreads them into RULES, so the ratchet, the scorecard and the edit hook
 * enforce them like the rest.
 *
 * Both rules read calls from the syntax tree (`parse.mjs`), so a call named
 * in a comment, a string or a regex literal does not count.
 */
import { parse, typescript, walk } from "./parse.mjs";

/** `fetch`, `globalThis.fetch`, `window.fetch` or `self.fetch`; not `client.fetch`. */
function isGlobalFetch(callee) {
  const ts = typescript();
  if (ts.isIdentifier(callee)) return callee.text === "fetch";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "fetch" &&
    ts.isIdentifier(callee.expression) &&
    ["globalThis", "window", "self"].includes(callee.expression.text)
  );
}

/** The name of an object literal property, quoted or not. */
function propertyName(property) {
  const ts = typescript();
  const name = property.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined;
}

/** `undefined`, `null` or `void 0`: a signal property that passes none. */
function isAbsent(value) {
  const ts = typescript();
  return (
    (ts.isIdentifier(value) && value.text === "undefined") ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(value)
  );
}

/**
 * Whether a `fetch` call visibly passes no signal: no options, or an options
 * object whose own `signal` is missing, `undefined` or `null`. A `signal`
 * nested deeper, as in `headers`, is not the request's. Options passed as a
 * variable, a call or a spread may carry one, so they do not count, and nor
 * does a pass-through `fetch(...args)`.
 */
function passesNoSignal(call) {
  const ts = typescript();
  if (call.arguments.some(ts.isSpreadElement)) return false;
  const init = call.arguments[1];
  if (init === undefined) return true;
  if (!ts.isObjectLiteralExpression(init)) return false;
  if (init.properties.some(ts.isSpreadAssignment)) return false;
  const signal = init.properties.find((p) => propertyName(p) === "signal");
  if (!signal) return true;
  return ts.isPropertyAssignment(signal) && isAbsent(signal.initializer);
}

/**
 * Offsets of global `fetch()` calls that pass no `signal`, so nothing can
 * cancel them. A method named `fetch` (a Worker's `fetch(request) {`) is a
 * definition, not a call.
 */
export function fetchCallsWithoutSignal(text, path) {
  const ts = typescript();
  const tree = parse(path, text);
  const offsets = [];
  walk(tree, (node) => {
    if (
      ts.isCallExpression(node) &&
      isGlobalFetch(node.expression) &&
      passesNoSignal(node)
    ) {
      offsets.push(node.getStart(tree));
    }
  });
  return offsets;
}

const CHILD_PROCESS_IMPORT =
  /["'](?:node:)?child_process["']|["']cross-spawn["']/;

const LISTEN = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);

/** `spawn(...)`, `fork(...)`, or either as a member (`cp.spawn(...)`). */
function isSpawn(call) {
  const ts = typescript();
  const callee = ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name
    : call.expression;
  return ts.isIdentifier(callee) && ["spawn", "fork"].includes(callee.text);
}

/** Whether `event` is the string `"error"`. */
function isErrorEvent(event) {
  const ts = typescript();
  return (
    event !== undefined &&
    (ts.isStringLiteral(event) || ts.isNoSubstitutionTemplateLiteral(event)) &&
    event.text === "error"
  );
}

/** Source text without whitespace, so `this . child` names `this.child`. */
const textOf = (node, tree) => node.getText(tree).replace(/\s+/g, "");

/**
 * The variable a child is assigned to, or nothing when the child is returned
 * or passed on, since whoever receives it may listen. `spawn(...).on("exit",
 * f)` returns the same child, so the chain is followed to its assignment; an
 * `error` listener anywhere in the chain handles it.
 */
function assignment(call) {
  const ts = typescript();
  let node = call;
  for (;;) {
    const parent = node.parent;
    if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
      node = parent;
    } else if (
      ts.isPropertyAccessExpression(parent) &&
      LISTEN.has(parent.name.text) &&
      ts.isCallExpression(parent.parent)
    ) {
      if (isErrorEvent(parent.parent.arguments[0])) return undefined;
      node = parent.parent;
    } else break;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return { target: parent.name, declaration: parent };
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node &&
    (ts.isIdentifier(parent.left) ||
      (ts.isPropertyAccessExpression(parent.left) &&
        parent.left.expression.kind === ts.SyntaxKind.ThisKeyword))
  ) {
    return { target: parent.left };
  }
  return undefined;
}

/**
 * Where a child held in `target` is reachable by that name: the class for
 * `this.child`, the block for `const` and `let`, and the function otherwise.
 * A listener outside it is on another variable that shares the name.
 */
function scopeOf({ target, declaration }) {
  const ts = typescript();
  let isScope = ts.isFunctionLike;
  if (ts.isPropertyAccessExpression(target)) isScope = ts.isClassLike;
  else if (
    declaration &&
    ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.BlockScoped
  ) {
    isScope = (n) => ts.isBlock(n) || ts.isCaseBlock(n) || ts.isFunctionLike(n);
  }
  let node = target.parent;
  while (!ts.isSourceFile(node) && !isScope(node)) node = node.parent;
  return node;
}

/**
 * The emitter a listener call is made on. `on` and its kin return the
 * emitter, so in `child.on("exit", f).on("error", g)` both are on `child`.
 */
function listenedTo(expression) {
  const ts = typescript();
  while (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    LISTEN.has(expression.expression.name.text)
  ) {
    expression = expression.expression.expression;
  }
  return expression;
}

/** `name.on("error", ...)` or a kin, or `once(name, "error")`, under `scope`. */
function listensForError(scope, name, tree) {
  const ts = typescript();
  let found = false;
  walk(scope, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    const [first, second] = node.arguments;
    found =
      (ts.isPropertyAccessExpression(callee) &&
        LISTEN.has(callee.name.text) &&
        textOf(listenedTo(callee.expression), tree) === name &&
        isErrorEvent(first)) ||
      (ts.isIdentifier(callee) &&
        ["once", "on"].includes(callee.text) &&
        first !== undefined &&
        textOf(first, tree) === name &&
        isErrorEvent(second));
  });
  return found;
}

/**
 * Child processes from `spawn` or `fork`, held in a variable with no `error`
 * listener on that variable in the scope where it lives. Node emits `error`
 * when the binary is missing or the process cannot start, and an emitter
 * with no listener throws it, so the caller's close or exit handler never
 * runs. A listener that a helper adds after the child is passed to it is
 * not seen, so such a child counts.
 */
export function countSpawnWithoutErrorListener(text, path) {
  if (!CHILD_PROCESS_IMPORT.test(text)) return 0;
  const ts = typescript();
  const tree = parse(path, text);
  let count = 0;
  walk(tree, (node) => {
    if (!ts.isCallExpression(node) || !isSpawn(node)) return;
    const held = assignment(node);
    if (!held) return;
    if (!listensForError(scopeOf(held), textOf(held.target, tree), tree)) {
      count += 1;
    }
  });
  return count;
}

export const REVIEW_RULES = [
  {
    id: "fetch-without-signal",
    label: "`fetch()` calls with no `signal`",
    fix: "Pass a `signal` so the request can be cancelled: the caller's signal, or `AbortSignal.timeout(ms)` where nothing above sets a deadline. `AbortSignal.any` combines the two.",
    count: (text, path) => fetchCallsWithoutSignal(text, path).length,
  },
  {
    id: "spawn-without-error-listener",
    label: "spawned child processes with no `error` listener",
    fix: 'Add `child.on("error", ...)` that settles the caller\'s promise and cleans up. Without it a missing binary or a failed start throws from the emitter instead of reaching your exit handler.',
    count: countSpawnWithoutErrorListener,
  },
];
