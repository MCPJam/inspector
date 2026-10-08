import { openaiPolicySource } from "../manifest.js";
import { OPENAI_READINESS_INPUTS } from "../types.js";
import {
  looksMutating,
  type OpenAIToolEvidence,
  type OpenAIToolListingCompleteness,
} from "./annotations.js";
import {
  informational,
  missingInput,
  notApplicable,
  notEvaluated,
  satisfied,
  violated,
  type OpenAICheckDefinition,
  type OpenAICheckStamp,
} from "./helpers.js";

const definitions: OpenAICheckDefinition[] = [
  ["declared", "Exactly one tool supplies authenticated profile information"],
  ["input-empty", "The profile tool accepts an empty argument object"],
  ["output-schema", "The profile tool publishes the profile response schema"],
  ["read-only", "The profile tool declares read-only behavior"],
  [
    "description-honesty",
    "The profile tool's name is consistent with read-only behavior",
  ],
].map(([id, title]) => ({
  id: `openai.profile.${id}`,
  title,
  lane:
    id === "description-honesty" ? "experience-insights" : "directory-policy",
  class: id === "description-honesty" ? "heuristic" : "required",
  source: openaiPolicySource("build/auth", "§Support multiple accounts"),
  provenance: "static",
  intrusiveness: "passive",
}));

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;
}

export function runOpenAIProfileChecks(
  tools: readonly OpenAIToolEvidence[] | undefined,
  stamp: OpenAICheckStamp,
  listing?: OpenAIToolListingCompleteness
) {
  if (!tools || listing?.complete === false)
    return definitions.map((def) =>
      notEvaluated(
        def,
        stamp,
        listing?.error ?? "A complete tool listing is required",
        missingInput(OPENAI_READINESS_INPUTS.toolListing)
      )
    );
  const marked = tools.filter(
    (tool) => tool._meta?.["openai/profile"] === true
  );
  const malformed = tools.filter(
    (tool) =>
      tool._meta &&
      Object.hasOwn(tool._meta, "openai/profile") &&
      typeof tool._meta["openai/profile"] !== "boolean"
  );
  const declared = definitions[0];
  const findings = [
    malformed.length || marked.length > 1
      ? violated(
          declared,
          stamp,
          "Designate exactly one profile tool using the boolean true marker.",
          {
            designated: marked.map((t) => t.name),
            malformed: malformed.map((t) => t.name),
          }
        )
      : marked.length === 1
      ? satisfied(declared, stamp)
      : notApplicable(
          declared,
          stamp,
          "No profile tool is designated; multi-account connections do not require one."
        ),
  ];
  if (marked.length !== 1)
    return [
      ...findings,
      ...definitions
        .slice(1)
        .map((def) =>
          marked.length === 0
            ? notApplicable(def, stamp, "No profile tool is designated")
            : notEvaluated(
                def,
                stamp,
                "Resolve the ambiguous profile designation first"
              )
        ),
    ];
  const tool = marked[0];
  const input = object(tool.inputSchema);
  const output = object(tool.outputSchema);
  const properties = object(output?.properties);
  const id = object(properties?.id);
  const checks = [
    // The contract is "accepts an empty argument object". A malformed schema
    // must not read as one: `properties: null` is not an empty property set,
    // it is a schema nobody can grade. `additionalProperties` is deliberately
    // NOT required here — the contract states it for the OUTPUT schema only,
    // and demanding it on the input would fail servers that satisfy the
    // stated contract.
    !!input &&
      input.type === "object" &&
      (input.required === undefined ||
        (Array.isArray(input.required) && input.required.length === 0)) &&
      (input.properties === undefined ||
        Object.keys(object(input.properties) ?? { malformed: true }).length ===
          0),
    !!output &&
      output.type === "object" &&
      output.additionalProperties === false &&
      Array.isArray(output.required) &&
      output.required.length === 1 &&
      output.required[0] === "id" &&
      id?.type === "string" &&
      id.minLength === 1 &&
      id.pattern === "\\S" &&
      !!properties &&
      Object.entries(properties).every(
        ([key, schema]) =>
          ["id", "name", "email", "nickname"].includes(key) &&
          object(schema)?.type === "string"
      ),
    tool.annotations?.readOnlyHint === true &&
      tool.annotations?.destructiveHint !== true,
  ];
  checks.forEach((ok, i) =>
    findings.push(
      ok
        ? satisfied(definitions[i + 1], stamp)
        : violated(definitions[i + 1], stamp, definitions[i + 1].title, {
            tool: tool.name,
          })
    )
  );
  findings.push(
    informational(
      definitions[4],
      stamp,
      { tool: tool.name, looksMutating: looksMutating(tool.name) },
      looksMutating(tool.name)
        ? "The name suggests mutation; verify the profile operation is read-only."
        : "The name does not suggest mutation; this does not establish runtime behavior."
    )
  );
  return findings;
}
