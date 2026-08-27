import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * THE THIRD RATCHET: the spec's schemas and the SDK's types describe the same
 * wire.
 *
 * Two guards already exist and neither could catch this. `openapi-drift`
 * compares PATHS and METHODS — it never opens a schema. `sdk-coverage` asks
 * whether a route is REACHABLE from the client — it never opens a type. So the
 * one thing a caller actually reads, the SHAPE of what comes back, was
 * described twice by hand with nothing comparing the two descriptions.
 *
 * The drift that motivated this is instructive because a name-only check would
 * have sailed past it: swarm findings carry a four-value lifecycle
 * (`new | recurring | regressed | resolved`), and the Inspector's DTO comment
 * claimed `open | resolved | dismissed`. Same field name, same type (`string`),
 * three of four values wrong, plus a value that is not a status at all. So this
 * compares:
 *
 *   - FIELD NAMES, in both directions;
 *   - REQUIREDNESS — SDK `?` against the schema's `required` list;
 *   - NULLABILITY — SDK `| null` against `"type": [..., "null"]`;
 *   - ENUM VALUES — SDK string-literal unions against `enum`, as sets;
 *   - NESTED TYPES — SDK `PlatformFoo` against `$ref: .../Foo`.
 *
 * ## A ratchet, not a wall
 *
 * `PAIRS` below is the seed: the schemas that have an SDK twin today. It is
 * meant to GROW — each PR that documents a route adds its schemas here, and
 * that addition is the point at which the two descriptions are forced to
 * agree. An entry naming a schema or interface that does not exist fails, so
 * the list cannot rot into a set of claims about things that are gone.
 *
 * Unlisted schemas are not checked. That is deliberate and is why this can
 * land before the surface is fully documented — but it means "not in PAIRS" is
 * a to-do, not a verdict.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, "../../../../../docs/reference/openapi.json");
const TYPES_PATH = resolve(here, "../../../../../sdk/src/platform/types.ts");

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  $ref?: string;
  description?: string;
  allOf?: Schema[];
};

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  components: { schemas: Record<string, Schema> };
};

/**
 * `openapi schema name` -> `sdk interface name`.
 *
 * Almost always the `Platform` prefix, but written out rather than derived: the
 * exceptions are real (`Environment` vs `ProjectEnvironment`,
 * `EvalRunSummary`) and a derived rule would silently skip every pair whose
 * names do not line up — checking nothing while looking like it checked
 * everything.
 */
const PAIRS: Readonly<Record<string, string>> = {
  Me: "PlatformMe",
  Organization: "PlatformOrganization",
  Project: "PlatformProject",
  ProjectServer: "PlatformProjectServer",
  ChatSession: "PlatformChatSession",
  EvalRun: "PlatformEvalRun",
  EvalRunEnvironment: "PlatformEvalRunEnvironment",
  EvalRunCreated: "PlatformEvalRunCreated",
  EvalRunGroupCreated: "PlatformEvalRunGroupCreated",
  EvalSuiteCreated: "PlatformEvalSuiteCreated",
  EvalSuite: "PlatformEvalSuite",
  EvalSuiteSchedule: "PlatformEvalSuiteSchedule",
  EvalSuiteComputerEnvironment: "PlatformEvalSuiteComputerEnvironment",
  EvalSuiteDetail: "PlatformEvalSuiteDetail",
  EvalSuiteFromFileSynced: "PlatformFileOwnedEvalSuiteSynced",
  EvalIteration: "PlatformEvalIteration",
  EvalCase: "PlatformEvalCase",
  EvalDeleted: "PlatformEvalSuiteDeleted",
  Client: "PlatformClient",
  ClientDetail: "PlatformClientDetail",
  ClientDeleted: "PlatformClientDeleted",
  EnvironmentSkillSelection: "PlatformEnvironmentSkillSelection",
  ProjectEnvironment: "PlatformEnvironment",
  AdhocEnvironment: "PlatformAdhocEnvironment",
  AdhocEnvironmentEnsured: "PlatformAdhocEnvironmentEnsured",
  EvalSuiteEnvironmentAttached: "PlatformEvalSuiteEnvironmentAttached",
  ProjectEnvironmentCapabilities: "PlatformEnvironmentCapabilities",
  ProjectEnvironmentResolved: "PlatformEnvironmentResolved",
  Plugin: "PlatformPlugin",
  PluginVersion: "PlatformPluginVersion",
  SandboxImage: "PlatformImage",
  SandboxImageBuild: "PlatformImageBuild",
  SandboxImageDeleted: "PlatformImageDeleted",
  SandboxImageBuildStarted: "PlatformImageBuildStarted",
  ComputerAttached: "PlatformComputerAttached",
  ComputerReset: "PlatformComputerReset",
  ScenarioLink: "PlatformScenarioLink",
  ScenarioServer: "PlatformScenarioServer",
  Scenario: "PlatformScenario",
  ScenarioDetail: "PlatformScenarioDetail",
  TunnelGrant: "PlatformTunnelGrant",
  TunnelClosed: "PlatformTunnelClosed",

  // ── A1: Swarms authoring ──────────────────────────────────────────────
  //
  // `GenerationDrafts` is deliberately NOT paired: its SDK twin is an index
  // signature (`{[field: string]: unknown}`) because the response shape
  // depends on the request, so a field-by-field comparison would report every
  // documented property as missing from a type that says "anything".
  Persona: "PlatformPersona",
  PersonaDeleted: "PlatformPersonaDeleted",
  PersonaDraft: "PlatformPersonaDraft",
  Journey: "PlatformJourney",
  JourneyArchived: "PlatformJourneyArchived",
  Swarm: "PlatformSwarm",
  SwarmArchived: "PlatformSwarmArchived",

  // ── A2: Swarm runs ────────────────────────────────────────────────────
  JourneyRun: "PlatformJourneyRun",
  JourneyRunTarget: "PlatformJourneyRunTarget",
  JourneyRunAttempt: "PlatformJourneyRunAttempt",
  JourneyRunSession: "PlatformJourneyRunSession",
  JourneyRunLaunched: "PlatformJourneyRunLaunched",
  JourneyRunCanceled: "PlatformJourneyRunCanceled",

  // ── A3: Swarm insights ────────────────────────────────────────────────
  ScorecardCriterion: "PlatformScorecardCriterion",
  RunScorecard: "PlatformRunScorecard",
  SwarmFinding: "PlatformSwarmFinding",
  FindingDismissed: "PlatformFindingDismissed",
  SwarmOverviewFinding: "PlatformSwarmOverviewFinding",
  SwarmOverviewRun: "PlatformSwarmOverviewRun",
  SwarmOverview: "PlatformSwarmOverview",
  WaveInsights: "PlatformWaveInsights",
  WaveInsightsRequested: "PlatformWaveInsightsRequested",
  WaveInsightsCanceled: "PlatformWaveInsightsCanceled",

  // ── A4: User testing ──────────────────────────────────────────────────
  //
  // `ScenarioLinkRotated`, `ScenarioMemberRemoved` and the three request
  // bodies have no SDK twin: the client returns those responses inline and
  // takes the bodies as parameters, so there is no interface to compare.
  Scenario: "PlatformScenario",
  ScenarioDeleted: "PlatformScenarioDeleted",
  UserTestingScenario: "PlatformUserTestingScenario",
  UserTestingScenarioDetail: "PlatformUserTestingScenarioDetail",
  UserTestingSession: "PlatformUserTestingSession",
  UserTestingSessionDetail: "PlatformUserTestingSessionDetail",
  TranscriptMessage: "PlatformTranscriptMessage",
  GuestExecution: "PlatformGuestExecution",

  // ── A5: the insights layer, and the planning read ─────────────────────
  //
  // The five user-testing ANALYTICS schemas (`ScenarioMetrics`,
  // `ScenarioUsage`, `ScenarioSignals`, `ScenarioWindowInsights`,
  // `ScenarioFinding`) are deliberately unpaired: the SDK types them as open
  // records because the upstream projections grow with the product, so a
  // field-by-field comparison against a type that says "anything" would report
  // every documented property as missing. Same reasoning as `GenerationDrafts`.
  //
  // `InsightScope` is unpaired for a different reason: its SDK twin is a
  // discriminated UNION of three object types, not an interface, and this
  // parser reads interfaces. Pairing it would need a second extraction path
  // for one schema.
  InsightsEnvelope: "PlatformInsightsEnvelope",
  ActionableFinding: "PlatformActionableFinding",
  ActionableFindingEvidence: "PlatformActionableFindingEvidence",
  ScenarioInsightsRequested: "PlatformUserTestingInsightsRequested",
  EvalRunInsightsRequested: "PlatformEvalRunInsightsRequested",
  EvalRunJudgeRequested: "PlatformEvalRunJudgeRequested",
  EvalRunJudges: "PlatformEvalRunJudges",
  EvalRunJudgeState: "PlatformEvalRunJudgeState",
  EvalRunGoalCompletionJudge: "PlatformEvalRunGoalCompletionJudge",
  EvalRunGroundednessJudge: "PlatformEvalRunGroundednessJudge",
  EvalRunJudgeCase: "PlatformEvalRunJudgeCase",
  EvalRunGoalCompletionCase: "PlatformEvalRunGoalCompletionCase",
  EvalRunGroundednessCase: "PlatformEvalRunGroundednessCase",
  ProjectCapabilities: "PlatformCapabilities",
};

/**
 * Fields a pair is allowed to disagree on, each with the reason.
 *
 * Keep this SMALL. Every entry is a place a caller can be surprised, and the
 * cost of an exemption is that the one axis it silences is the one nothing
 * will ever check again.
 *
 * EMPTY, and worth keeping that way. It held `EvalRun.insights` and
 * `JourneyRun.insights` while the envelope was undocumented; both came off in
 * the same change that documented it, which is what the note there promised.
 */
const FIELD_EXEMPTIONS: Readonly<Record<string, Readonly<string[]>>> = {};
// ── SDK type extraction ─────────────────────────────────────────────────────

type SdkField = {
  name: string;
  optional: boolean;
  nullable: boolean;
  /** String-literal union members, when the type is one. */
  enumValues: string[] | null;
  /** `PlatformFoo` when the type (or its array element) is an interface ref. */
  refName: string | null;
  isArray: boolean;
};

type SdkInterface = {
  name: string;
  fields: Map<string, SdkField>;
  /** `extends` targets, resolved after every interface has been read. */
  heritage: string[];
};

/**
 * Strip the wrappers that do not change the type being described: parentheses,
 * and the `readonly` operator.
 *
 * A checker that skips this does not fail — it silently stops measuring.
 * `readonly Foo[]` reads as neither an array nor a ref, and `(Foo | null)`
 * reads as an opaque node rather than a nullable union, so both fields compare
 * clean against anything the spec says. Neither spelling is in `types.ts`
 * today; both are one ordinary edit away.
 */
function unwrapTypeNode(node: ts.TypeNode): ts.TypeNode {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedTypeNode(current)) {
      current = current.type;
      continue;
    }
    if (
      ts.isTypeOperatorNode(current) &&
      current.operator === ts.SyntaxKind.ReadonlyKeyword
    ) {
      current = current.type;
      continue;
    }
    return current;
  }
}

/**
 * `Child extends Parent` where `Parent` is not declared in `types.ts`. Asserted
 * on below rather than swallowed — see `flatten`.
 */
const unresolvedHeritage: string[] = [];

function parseSdkInterfaces(): Map<string, SdkInterface> {
  const source = ts.createSourceFile(
    TYPES_PATH,
    readFileSync(TYPES_PATH, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  const out = new Map<string, SdkInterface>();

  const describeType = (
    node: ts.TypeNode
  ): Omit<SdkField, "name" | "optional"> => {
    let nullable = false;
    const root = unwrapTypeNode(node);
    let members: ts.TypeNode[] = [root];

    // A field typed EXACTLY `null` (not `X | null`) is nullable too. Without
    // this the parser sees only the union form, so a field whose sole type is
    // null reads as non-nullable and disagrees with a spec that correctly says
    // it is — a false positive on the honest description.
    if (
      root.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isLiteralTypeNode(root) &&
        root.literal.kind === ts.SyntaxKind.NullKeyword)
    ) {
      return { nullable: true, enumValues: null, refName: null, isArray: false };
    }

    if (ts.isUnionTypeNode(root)) {
      members = root.types.map(unwrapTypeNode).filter((t) => {
        // `| null` and `| undefined` are nullability, not variants.
        if (t.kind === ts.SyntaxKind.NullKeyword) {
          nullable = true;
          return false;
        }
        if (
          ts.isLiteralTypeNode(t) &&
          t.literal.kind === ts.SyntaxKind.NullKeyword
        ) {
          nullable = true;
          return false;
        }
        if (t.kind === ts.SyntaxKind.UndefinedKeyword) return false;
        return true;
      });
    }

    // A union of string literals is an enum.
    const literals = members.filter(
      (t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)
    );
    const enumValues =
      literals.length > 0 && literals.length === members.length
        ? literals.map(
            (t) => ((t as ts.LiteralTypeNode).literal as ts.StringLiteral).text
          )
        : null;

    let isArray = false;
    let refName: string | null = null;
    for (const member of members) {
      let target = unwrapTypeNode(member);
      if (ts.isArrayTypeNode(target)) {
        isArray = true;
        target = unwrapTypeNode(target.elementType);
      }
      if (ts.isTypeReferenceNode(target)) {
        const name = target.typeName.getText();
        if (
          (name === "Array" || name === "ReadonlyArray") &&
          target.typeArguments?.length === 1
        ) {
          isArray = true;
          const inner = unwrapTypeNode(target.typeArguments[0]!);
          if (ts.isTypeReferenceNode(inner)) refName = inner.typeName.getText();
        } else {
          refName = name;
        }
      }
    }

    return { nullable, enumValues, refName, isArray };
  };

  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      const fields = new Map<string, SdkField>();
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const name = member.name.getText().replace(/^["']|["']$/g, "");
        fields.set(name, {
          name,
          optional: member.questionToken !== undefined,
          ...describeType(member.type),
        });
      }
      const heritage = (node.heritageClauses ?? [])
        .filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        .flatMap((clause) => clause.types.map((t) => t.expression.getText()));
      out.set(node.name.text, { name: node.name.text, fields, heritage });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Flatten `extends`. Without this every inherited field reads as "documented
  // in the spec, absent from the SDK" — `PlatformScenarioDetail extends
  // PlatformScenario` alone produced twelve such phantoms, which is exactly the
  // noise that gets a ratchet switched off.
  //
  // A child's own declaration WINS over an inherited one: that is what
  // `interface X extends Y { field: Narrower }` means, and reading it the other
  // way would compare against the type the child deliberately replaced.
  //
  // The result is MEMOIZED, and the cycle guard is a separate per-path set.
  // Those have to be two things. A single shared `seen` set doubles as both,
  // and then a diamond — `A extends B, C`, both extending `D` — resolves `D`
  // fully down the first branch and returns it UNFLATTENED down the second,
  // because the guard cannot tell "already finished" from "currently on the
  // stack". Everything `D` inherited then vanishes from `A`, and the ratchet
  // reports the loss as spec drift.
  const cache = new Map<string, SdkInterface>();

  const flatten = (name: string, onStack: Set<string>): SdkInterface => {
    const cached = cache.get(name);
    if (cached) return cached;
    const iface = out.get(name)!;
    // A heritage cycle is not legal TypeScript; refuse to hang on one anyway,
    // and do not cache the truncated answer.
    if (onStack.has(name)) return iface;
    onStack.add(name);
    const merged = new Map<string, SdkField>();
    for (const parent of iface.heritage) {
      // An `extends` target declared in ANOTHER file. Recorded rather than
      // skipped: silently dropping it leaves the child looking like it has
      // fewer fields than it does, and the ratchet then reports the parent's
      // fields as spec drift — or, worse, compares a narrower type clean. The
      // check below turns that into a visible failure instead.
      if (!out.has(parent)) {
        unresolvedHeritage.push(`${name} extends ${parent}`);
        continue;
      }
      for (const [field, value] of flatten(parent, onStack).fields) {
        merged.set(field, value);
      }
    }
    for (const [field, value] of iface.fields) merged.set(field, value);
    onStack.delete(name);
    const result = { ...iface, fields: merged };
    cache.set(name, result);
    return result;
  };

  const flattened = new Map<string, SdkInterface>();
  for (const name of out.keys()) flattened.set(name, flatten(name, new Set()));
  return flattened;
}

const sdkInterfaces = parseSdkInterfaces();

// ── schema reading ──────────────────────────────────────────────────────────

type Composed = Schema & { oneOf?: Schema[]; anyOf?: Schema[] };

/** The `oneOf`/`anyOf` branches, or `null` when the schema is not composed. */
function branches(schema: Schema): Schema[] | null {
  const composed = schema as Composed;
  return composed.oneOf ?? composed.anyOf ?? null;
}

/**
 * Nullability, in all three spellings this spec uses.
 *
 * `"type": ["string","null"]` is the common one, but a nullable `$ref` CANNOT
 * be written that way — a `$ref` takes no sibling `type` — so those appear as
 * `oneOf: [{$ref}, {"type": "null"}]`. Reading only the first form reported
 * every nullable ref as a spec/SDK disagreement, which is four false positives
 * pointing at correct code.
 */
function schemaIsNullable(schema: Schema): boolean {
  if (Array.isArray(schema.type)) return schema.type.includes("null");
  if ((schema as { nullable?: boolean }).nullable === true) return true;
  return (branches(schema) ?? []).some((b) => b.type === "null");
}

function schemaRefName(schema: Schema): string | null {
  const direct = schema.$ref ?? schema.items?.$ref;
  if (direct) return direct.split("/").pop() ?? null;
  // The nullable-ref form above: the real type is the non-null branch. RECURSE
  // rather than reading `branch.$ref` — a nullable ARRAY OF refs puts the ref
  // one level further down, at `branch.items.$ref`, and stopping short there
  // reports "no nested type" for a field that has one, which is a comparison
  // that always succeeds.
  for (const branch of branches(schema) ?? []) {
    const nested = schemaRefName(branch);
    if (nested) return nested;
  }
  return null;
}

/**
 * Both readers below fall through to the composed branches for the same reason
 * `schemaRefName` does: a nullable array and a nullable enum cannot be written
 * with a sibling `type` either, so they arrive as
 * `oneOf: [{type:"array",...}, {type:"null"}]`. Reading only the top level
 * would call those "not an array" and "not an enum" and quietly stop comparing
 * the one property the check exists to compare.
 */
function schemaIsArray(schema: Schema): boolean {
  const type = schema.type;
  if (Array.isArray(type)) return type.includes("array");
  if (type === "array") return true;
  return (branches(schema) ?? []).some((b) => schemaIsArray(b));
}

/** Enum values minus the `null` that only restates nullability. */
function schemaEnum(schema: Schema): string[] | null {
  const source = schema.enum ?? schema.items?.enum;
  if (source) return source.filter((v): v is string => typeof v === "string");
  for (const branch of branches(schema) ?? []) {
    const nested = schemaEnum(branch);
    if (nested && nested.length > 0) return nested;
  }
  return null;
}

// ── the checks ──────────────────────────────────────────────────────────────

describe("openapi.json ↔ sdk/src/platform/types.ts parity", () => {
  it("every PAIRS entry names a schema and an interface that exist", () => {
    // A ratchet whose entries can go stale stops being one: it would keep
    // passing while checking nothing.
    const missingSchemas = Object.keys(PAIRS)
      .filter((name) => !spec.components.schemas[name])
      .sort();
    const missingInterfaces = Object.values(PAIRS)
      .filter((name) => !sdkInterfaces.has(name))
      .sort();

    expect(
      missingSchemas,
      `PAIRS names openapi schemas that no longer exist:\n  ${missingSchemas.join(
        "\n  "
      )}`
    ).toEqual([]);
    expect(
      missingInterfaces,
      `PAIRS names SDK interfaces that no longer exist:\n  ${missingInterfaces.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("resolves every `extends` target it was asked to flatten", () => {
    // A parent declared outside `types.ts` cannot be flattened, so the child
    // reads as having only its own fields. That does not fail anything on its
    // own — it makes the comparison SMALLER, which is the failure mode this
    // whole file exists to avoid. Fail loudly and let whoever adds the
    // cross-file base decide how to teach the parser about it.
    expect(
      unresolvedHeritage,
      `SDK interfaces extend types this parser cannot see, so their inherited fields are NOT being compared:\n  ${unresolvedHeritage.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("describes the same FIELDS in both directions", () => {
    const problems: string[] = [];

    for (const [schemaName, interfaceName] of Object.entries(PAIRS)) {
      const schema = spec.components.schemas[schemaName];
      const iface = sdkInterfaces.get(interfaceName);
      if (!schema || !iface) continue;
      const exempt = new Set(FIELD_EXEMPTIONS[schemaName] ?? []);

      const specFields = new Set(Object.keys(schema.properties ?? {}));
      const sdkFields = new Set(iface.fields.keys());

      for (const field of specFields) {
        if (exempt.has(field)) continue;
        if (!sdkFields.has(field)) {
          problems.push(
            `${schemaName}.${field}: documented in the spec, absent from ${interfaceName}`
          );
        }
      }
      for (const field of sdkFields) {
        if (exempt.has(field)) continue;
        if (!specFields.has(field)) {
          problems.push(
            `${interfaceName}.${field}: in the SDK type, undocumented in schema ${schemaName}`
          );
        }
      }
    }

    expect(problems.sort(), problems.join("\n")).toEqual([]);
  });

  it("agrees on REQUIREDNESS", () => {
    // A field the spec calls required and the SDK marks `?` tells a caller to
    // handle an absence that can never happen; the reverse promises one the
    // wire does not keep.
    //
    // ONE equivalence is allowed, and it is a convention difference rather
    // than a disagreement. "Always present, sometimes empty" is spelled two
    // ways in this codebase:
    //
    //   spec:  not in `required`, `"type": ["string", "null"]`
    //   SDK:   `field: string | null`  (required, nullable)
    //
    // Both tell a caller the same thing — check before you use it — and in
    // JavaScript the two are not even distinguishable at the call site
    // (`obj.x` is `undefined` for an absent field, and `undefined == null`).
    // Flagging them would bury the handful of REAL mismatches under ninety
    // restatements of a house style, which is how a ratchet gets switched off.
    const problems: string[] = [];

    for (const [schemaName, interfaceName] of Object.entries(PAIRS)) {
      const schema = spec.components.schemas[schemaName];
      const iface = sdkInterfaces.get(interfaceName);
      if (!schema || !iface) continue;
      const exempt = new Set(FIELD_EXEMPTIONS[schemaName] ?? []);
      const required = new Set(schema.required ?? []);

      for (const [field, sdkField] of iface.fields) {
        if (exempt.has(field)) continue;
        const prop = (schema.properties ?? {})[field];
        if (!prop) continue;
        const specRequired = required.has(field);
        if (specRequired !== sdkField.optional) continue; // agree outright
        const conventionMatch =
          !specRequired &&
          !sdkField.optional &&
          schemaIsNullable(prop) &&
          sdkField.nullable;
        if (conventionMatch) continue;
        problems.push(
          `${schemaName}.${field}: spec says ${
            specRequired ? "required" : "optional"
          }, SDK says ${sdkField.optional ? "optional" : "required"}`
        );
      }
    }

    expect(problems.sort(), problems.join("\n")).toEqual([]);
  });

  it("agrees on NULLABILITY", () => {
    // `string | null` and `string` are different contracts. Getting this wrong
    // is how a caller ships code that crashes on the first row with no value.
    const problems: string[] = [];

    for (const [schemaName, interfaceName] of Object.entries(PAIRS)) {
      const schema = spec.components.schemas[schemaName];
      const iface = sdkInterfaces.get(interfaceName);
      if (!schema || !iface) continue;
      const exempt = new Set(FIELD_EXEMPTIONS[schemaName] ?? []);

      for (const [field, sdkField] of iface.fields) {
        if (exempt.has(field)) continue;
        const prop = (schema.properties ?? {})[field];
        if (!prop) continue;
        const specNullable = schemaIsNullable(prop);
        if (specNullable !== sdkField.nullable) {
          problems.push(
            `${schemaName}.${field}: spec ${
              specNullable ? "allows" : "forbids"
            } null, SDK ${sdkField.nullable ? "allows" : "forbids"} it`
          );
        }
      }
    }

    expect(problems.sort(), problems.join("\n")).toEqual([]);
  });

  it("agrees on ENUM VALUES", () => {
    // The axis a name-only check misses, and the one that produced the drift
    // this file exists for: same name, same `string` type, wrong values.
    const problems: string[] = [];

    for (const [schemaName, interfaceName] of Object.entries(PAIRS)) {
      const schema = spec.components.schemas[schemaName];
      const iface = sdkInterfaces.get(interfaceName);
      if (!schema || !iface) continue;
      const exempt = new Set(FIELD_EXEMPTIONS[schemaName] ?? []);

      for (const [field, sdkField] of iface.fields) {
        if (exempt.has(field)) continue;
        const prop = (schema.properties ?? {})[field];
        if (!prop) continue;
        const specValues = schemaEnum(prop);
        const sdkValues = sdkField.enumValues;
        // One side unconstrained is allowed in ONE direction only: an
        // open-ended `string` in the SDK against an enumerated spec is a
        // looser type, not a contradiction. The reverse — the SDK naming
        // values the spec does not document — is a caller reading a closed
        // union off a field the API says can be anything.
        if (sdkValues && !specValues) {
          problems.push(
            `${schemaName}.${field}: SDK constrains to [${sdkValues.join(
              " | "
            )}], spec documents no enum`
          );
          continue;
        }
        if (!sdkValues || !specValues) continue;
        const missingFromSdk = specValues.filter((v) => !sdkValues.includes(v));
        const missingFromSpec = sdkValues.filter(
          (v) => !specValues.includes(v)
        );
        if (missingFromSdk.length || missingFromSpec.length) {
          problems.push(
            `${schemaName}.${field}: enum mismatch — spec-only [${missingFromSdk.join(
              ", "
            )}], sdk-only [${missingFromSpec.join(", ")}]`
          );
        }
      }
    }

    expect(problems.sort(), problems.join("\n")).toEqual([]);
  });

  it("agrees on NESTED TYPES and array-ness", () => {
    // A `$ref` on one side and an inline object on the other is survivable; a
    // ref to the WRONG schema, or an array where the other side has a single
    // value, is not.
    const problems: string[] = [];
    const schemaForInterface = new Map(
      Object.entries(PAIRS).map(([schemaName, ifaceName]) => [
        ifaceName,
        schemaName,
      ])
    );

    for (const [schemaName, interfaceName] of Object.entries(PAIRS)) {
      const schema = spec.components.schemas[schemaName];
      const iface = sdkInterfaces.get(interfaceName);
      if (!schema || !iface) continue;
      const exempt = new Set(FIELD_EXEMPTIONS[schemaName] ?? []);

      for (const [field, sdkField] of iface.fields) {
        if (exempt.has(field)) continue;
        const prop = (schema.properties ?? {})[field];
        if (!prop) continue;

        if (schemaIsArray(prop) !== sdkField.isArray) {
          problems.push(
            `${schemaName}.${field}: spec ${
              schemaIsArray(prop) ? "is" : "is not"
            } an array, SDK ${sdkField.isArray ? "is" : "is not"}`
          );
        }

        const specRef = schemaRefName(prop);
        // Only checked when BOTH sides name a type this file knows how to
        // compare. An SDK `Record<string, unknown>` against an inline spec
        // object is not a mismatch, it is the same "opaque bag" on both sides.
        if (specRef && sdkField.refName) {
          const expected = schemaForInterface.get(sdkField.refName);
          if (expected && expected !== specRef) {
            problems.push(
              `${schemaName}.${field}: spec refs ${specRef}, SDK refs ${sdkField.refName} (=${expected})`
            );
          }
        }
      }
    }

    expect(problems.sort(), problems.join("\n")).toEqual([]);
  });
});
