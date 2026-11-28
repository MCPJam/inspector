/**
 * The agent parity map: for every backend function the app calls, whether
 * agents can do the same, and if not, why.
 *
 * The rule: anything you can do in the product, agents can do too, through
 * REST, the SDK, MCP and the CLI, except what is not worth exposing, which
 * gets a recorded reason here. Reads count as well as writes, because an agent
 * needs the reads to check what a write did.
 *
 * Most functions need no entry: a function a v1 route file names is
 * reachable, and the route → client method → operation → MCP/CLI links are
 * each checked by their own tests (`sdk-coverage.test.ts`, the SDK's
 * `client-method-operation-coverage.test.ts`, and the MCP and CLI binding
 * tests). `agent-parity.test.ts` fails when the app names a function that
 * none of this accounts for.
 *
 * What this cannot see. It works at the level of function NAMES:
 * - Arguments. A route that calls the right function the wrong way (the eval
 *   insights route once requested the legacy analysis where the app requests
 *   `mode: "findings"`) reads as reachable.
 * - Compositions. When the app chains calls (build findings, wait, then
 *   analyze), each call can be reachable while the sequence is not obvious to
 *   an agent. Say so in the operations' descriptions.
 * - Features the Inspector server serves itself, outside the v1 routes.
 * - REST-only routes. A function a v1 route names counts as reachable even
 *   when the SDK leaves that route out (`EXCLUDED_FROM_SDK` in
 *   `sdk-coverage.test.ts`), so MCP and the CLI cannot call it.
 * A passing test does not mean agents can do everything the app does.
 *
 * The repo is public: reasons here are one line, with no internal detail.
 */

/**
 * Strings shaped `prefix:name` that are not backend functions. An entry
 * exempts every string with that prefix, a whole backend module if one is
 * ever named the same, so each says what the strings are.
 */
export const NOT_BACKEND_PREFIXES: Readonly<Record<string, string>> = {
  about: "`about:blank`, a browser URL",
  auditevents: "WorkOS audit log action names",
  check: "eval step picker check ids",
  connection: "server facts row keys",
  discovery: "server facts row keys",
  draft: "new test case sentinel ids, never stored",
  judge: "suite grading model keys",
  lc: "canvas builder option strings",
  match: "suite grading model keys",
  mode: "tool choice picker values",
  node: "Node built-in module specifiers in test fixtures",
  preset: "host capability catalog preset ids",
  read: "OAuth scope names",
  route: "case scorecard and case spine keys",
  scenario: "raw data export section keys",
  sm: "Tailwind responsive class names",
  style: "eval helper fallback labels",
  swarm: "raw data export section keys",
  toolCalls: "suite grading model keys",
  vite: "Vite runtime event names",
  widget: "eval step picker widget check ids",
};

/**
 * App calls whose capability agents reach through a DIFFERENT function: the
 * backend function → the operation that covers it.
 */
export const COVERED: Readonly<Record<string, string>> = {};

/**
 * App calls agents should not have: a function, or `module:*` for a whole
 * module → a one-line reason.
 */
export const NOT_EXPOSED: Readonly<Record<string, string>> = {
  "projectAccessRequests:requestProjectAccess":
    "A person asks from the screen a project link shows when they lack access; agents work in projects they already belong to",
  "projectAccessRequests:getProjectAccessRequest":
    "Feeds the page an owner opens from the request email or bell to approve it; agents do not decide access requests",
  "projectAccessRequests:decideProjectAccessRequest":
    "Grants a person access to a project and can add them to the organization; owners decide in the app or from the email",
  "directChatHistory/multiModelGroups:actOnCurrentMultiModelGroup":
    "Group rename, pin, and archive are flag-gated Sessions rail actions. The public API works with individual sessions",
  "chatSessionPromote:findSimilarPlaygroundPrompt":
    "Drives the Playground's repeat-prompt tip; agents save a prompt as a test case directly instead of being nudged",
  "serverFeatureEvidence:getForServer":
    "Feeds the server canvas page, behind the server-canvas flag; an agent route follows if agents need the same saved evidence",
  "credentials:getCredentialExportPolicy":
    "Organization security setting; agents see its effect when a credential delivery is refused",
  "credentials:setCredentialExportPolicy":
    "Organization security setting that controls where credentials can go; only admins change it, in the app",
  "webClients:*":
    "Claude web and ChatGPT web accounts, behind the web-clients-enabled flag; their v1 routes follow with the web account API",
  "webClientSuites:*":
    "A suite's Claude web and ChatGPT web account choices, behind the web-clients-enabled flag; their v1 routes follow with the web account API",
  "webClientReconnect:*":
    "Runs waiting for a Claude web or ChatGPT web sign-in, behind the web-clients-enabled flag; their v1 routes follow with the web account API",
  "customJudgePreviewAuth:listCustomJudgePreviewIterations":
    "Past iterations to try a custom judge draft on, behind the evaluator-library flag; a v1 route follows with custom judge authoring",
  "customJudgePreview:previewCustomJudge":
    "Tries an unsaved custom judge draft on a past iteration, behind the evaluator-library flag; a v1 route follows with custom judge authoring",
};

/**
 * The length of `backlog.json`: app calls from before this check existed,
 * each one undecided. Follow-up tasks per feature family expose an entry or
 * move it into `COVERED` or `NOT_EXPOSED`, then delete it here and lower this
 * number. It never goes up.
 */
export const BACKLOG_MAX = 319;
