/**
 * `agents/openai.yaml` — the plugin's OpenAI-facing interface and policy
 * document.
 *
 * WHY THE REAL YAML PARSER. The `yaml` dependency is already here, and the
 * flat-frontmatter subset parser that `plugin-bundle` uses is deliberately not
 * enough for this file: `dependencies.tools` is a list of maps, `policy.products`
 * is a sequence, and a subset parser handed a nested document does not fail —
 * it returns a shape that is missing things, which grades as "field absent"
 * when the truth is "we could not read it". Those two must never look alike.
 *
 * WHY IT REPORTS INSTEAD OF THROWING. A malformed document is a FINDING, not an
 * exception: the submitter did the work and got it wrong, and an exception here
 * would either crash a grading run or get swallowed into "no metadata", which
 * reads as our limitation rather than their mistake.
 *
 * Pure. Safe from the browser entry.
 */

import { parse as parseYaml } from "yaml";

import { OPENAI_FIELD_LIMITS } from "../profile.js";
import { checkBrandColor } from "./color.js";
import {
  findUnsupportedCharacters,
  hasSurroundingWhitespace,
} from "./supported-text.js";

/** One problem with the document, in terms the submitter can act on. */
export interface OpenAIAgentMetadataIssue {
  /** Dotted path, e.g. `interface.display_name`. `(root)` for the document. */
  path: string;
  message: string;
}

/** A declared MCP dependency, as written. */
export interface OpenAIAgentToolDependency {
  type?: string;
  value?: string;
  transport?: string;
  url?: string;
}

export interface OpenAIAgentInterface {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface OpenAIAgentPolicy {
  products?: string[];
  allowImplicitInvocation?: boolean;
}

export interface OpenAIAgentMetadata {
  interface: OpenAIAgentInterface;
  policy: OpenAIAgentPolicy;
  dependencies: { tools: OpenAIAgentToolDependency[] };
}

export interface OpenAIAgentMetadataParse {
  /** Absent only when the document could not be read as a YAML mapping. */
  metadata?: OpenAIAgentMetadata;
  issues: OpenAIAgentMetadataIssue[];
}

/**
 * A MAPPING, not merely an object.
 *
 * `typeof value === "object"` is true of things a document can be that are not
 * mappings, and every one of them would be read field-by-field as a mapping
 * whose fields are all absent — reporting a document that is UNREADABLE as one
 * that is merely incomplete. Those two carry different advice.
 *
 * Under this parser's default schema (YAML 1.2 core) the reachable non-mapping
 * objects are arrays, which the test below already excluded. The prototype
 * check is for the schema that is one option away: YAML 1.1 resolves the
 * `!!timestamp` tag, and `2024-01-01` alone in a document then parses to a
 * `Date` — an object, not an array, and not a mapping. Cheap to hold now,
 * versus a silent misdiagnosis if that option is ever set.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Read a string field, recording a type error rather than coercing. */
function readString(
  container: Record<string, unknown>,
  key: string,
  path: string,
  issues: OpenAIAgentMetadataIssue[],
): string | undefined {
  const value = container[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    // Coercing a number to a string here would let `brand_color: 0x336699`
    // through as the text "3368601", which then fails a hex check with a
    // message about the wrong thing.
    issues.push({
      path,
      message: `must be a string, got ${Array.isArray(value) ? "a list" : typeof value}`,
    });
    return undefined;
  }
  return value;
}

function checkTextField(
  value: string | undefined,
  path: string,
  maxLength: number | undefined,
  issues: OpenAIAgentMetadataIssue[],
): void {
  if (value === undefined) return;
  if (value.trim().length === 0) {
    issues.push({ path, message: "must not be empty" });
    return;
  }
  if (hasSurroundingWhitespace(value)) {
    issues.push({ path, message: "has leading or trailing whitespace" });
  }
  const unsupported = findUnsupportedCharacters(value);
  if (unsupported.length > 0) {
    issues.push({
      path,
      message: `contains unsupported characters: ${unsupported
        .map((entry) => `${entry.codePoint} (${entry.kind}) at ${entry.index}`)
        .join(", ")}`,
    });
  }
  if (maxLength !== undefined && value.length > maxLength) {
    issues.push({
      path,
      message: `is ${value.length} characters; the maximum is ${maxLength}`,
    });
  }
}

/**
 * Parse and validate the document.
 *
 * Field NAMES are snake_case on the wire and camelCase in the DTO. The mapping
 * is explicit rather than a generic transform so an unrecognised key stays
 * unrecognised: a document with `displayName` instead of `display_name` has a
 * missing field, and a helpful transformer would silently accept a spelling the
 * portal does not.
 */
export function parseOpenAIAgentMetadata(
  source: string,
): OpenAIAgentMetadataParse {
  const issues: OpenAIAgentMetadataIssue[] = [];

  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    return {
      issues: [
        {
          path: "(root)",
          message: `is not valid YAML: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  // An empty file parses to `null`, which is not an error in YAML but is one
  // here: the document exists and declares nothing.
  if (!isPlainObject(document)) {
    return {
      issues: [
        {
          path: "(root)",
          message:
            document === null || document === undefined
              ? "is empty"
              : "must be a mapping at the top level",
        },
      ],
    };
  }

  const interfaceSection = document.interface;
  const interfaceValue: OpenAIAgentInterface = {};
  if (interfaceSection !== undefined) {
    if (!isPlainObject(interfaceSection)) {
      issues.push({ path: "interface", message: "must be a mapping" });
    } else {
      interfaceValue.displayName = readString(
        interfaceSection,
        "display_name",
        "interface.display_name",
        issues,
      );
      interfaceValue.shortDescription = readString(
        interfaceSection,
        "short_description",
        "interface.short_description",
        issues,
      );
      interfaceValue.iconSmall = readString(
        interfaceSection,
        "icon_small",
        "interface.icon_small",
        issues,
      );
      interfaceValue.iconLarge = readString(
        interfaceSection,
        "icon_large",
        "interface.icon_large",
        issues,
      );
      interfaceValue.brandColor = readString(
        interfaceSection,
        "brand_color",
        "interface.brand_color",
        issues,
      );
      interfaceValue.defaultPrompt = readString(
        interfaceSection,
        "default_prompt",
        "interface.default_prompt",
        issues,
      );

      checkTextField(
        interfaceValue.displayName,
        "interface.display_name",
        OPENAI_FIELD_LIMITS.displayNameMaxLength,
        issues,
      );
      checkTextField(
        interfaceValue.shortDescription,
        "interface.short_description",
        OPENAI_FIELD_LIMITS.shortDescriptionMaxLength,
        issues,
      );
      checkTextField(
        interfaceValue.defaultPrompt,
        "interface.default_prompt",
        OPENAI_FIELD_LIMITS.defaultPromptMaxLength,
        issues,
      );

      if (interfaceValue.brandColor !== undefined) {
        const brand = checkBrandColor(interfaceValue.brandColor);
        if (!brand.parsed) {
          issues.push({
            path: "interface.brand_color",
            message: "must be a six-digit hex color such as `#336699`",
          });
        } else if (!brand.passes) {
          issues.push({
            path: "interface.brand_color",
            message:
              `contrasts ${brand.worstRatio?.toFixed(2)}:1 against the worse of the two ` +
              `ChatGPT backgrounds; both must reach the minimum`,
          });
        }
      }
    }
  }

  const policySection = document.policy;
  const policyValue: OpenAIAgentPolicy = {};
  if (policySection !== undefined) {
    if (!isPlainObject(policySection)) {
      issues.push({ path: "policy", message: "must be a mapping" });
    } else {
      const products = policySection.products;
      if (products !== undefined) {
        if (
          !Array.isArray(products) ||
          products.some((entry) => typeof entry !== "string")
        ) {
          issues.push({
            path: "policy.products",
            message: "must be a list of strings",
          });
        } else {
          policyValue.products = products as string[];
        }
      }

      const implicit = policySection.allow_implicit_invocation;
      if (implicit !== undefined) {
        if (typeof implicit !== "boolean") {
          // YAML's `yes`/`no` already parse as booleans; a STRING here means the
          // author quoted it, and reading `"false"` as truthy would invert the
          // one field that decides whether ChatGPT may call this unprompted.
          issues.push({
            path: "policy.allow_implicit_invocation",
            message: "must be a boolean",
          });
        } else {
          policyValue.allowImplicitInvocation = implicit;
        }
      }
    }
  }

  const dependenciesSection = document.dependencies;
  const tools: OpenAIAgentToolDependency[] = [];
  if (dependenciesSection !== undefined) {
    if (!isPlainObject(dependenciesSection)) {
      issues.push({ path: "dependencies", message: "must be a mapping" });
    } else if (dependenciesSection.tools !== undefined) {
      const declared = dependenciesSection.tools;
      if (!Array.isArray(declared)) {
        issues.push({
          path: "dependencies.tools",
          message: "must be a list",
        });
      } else {
        declared.forEach((entry, index) => {
          const path = `dependencies.tools[${index}]`;
          if (!isPlainObject(entry)) {
            issues.push({ path, message: "must be a mapping" });
            return;
          }
          const tool: OpenAIAgentToolDependency = {
            type: readString(entry, "type", `${path}.type`, issues),
            value: readString(entry, "value", `${path}.value`, issues),
            transport: readString(
              entry,
              "transport",
              `${path}.transport`,
              issues,
            ),
            url: readString(entry, "url", `${path}.url`, issues),
          };
          if (tool.type === undefined) {
            issues.push({ path: `${path}.type`, message: "is required" });
          } else if (tool.type !== "mcp") {
            issues.push({
              path: `${path}.type`,
              message: `must be "mcp"; got "${tool.type}"`,
            });
          }
          if (tool.url !== undefined && !/^https:\/\//i.test(tool.url)) {
            // A public submission's dependency has to be reachable by the host,
            // so plain HTTP is not a style preference here.
            issues.push({
              path: `${path}.url`,
              message: "must be an https:// URL",
            });
          }
          tools.push(tool);
        });
      }
    }
  }

  return {
    metadata: {
      interface: interfaceValue,
      policy: policyValue,
      dependencies: { tools },
    },
    issues,
  };
}

/**
 * Cross-check the declared MCP dependencies against the servers the package
 * actually declares.
 *
 * Both directions are reported, because they are different mistakes: a
 * dependency naming a server that does not exist is a broken reference, and a
 * declared server no dependency names is a server the host will never be told
 * to connect to. Reporting only the first would leave the second invisible
 * until a reviewer noticed the plugin does nothing.
 */
export function crossCheckToolDependencies(
  tools: readonly OpenAIAgentToolDependency[],
  declaredServerNames: readonly string[],
): OpenAIAgentMetadataIssue[] {
  const issues: OpenAIAgentMetadataIssue[] = [];
  const declared = new Set(declaredServerNames);
  const referenced = new Set<string>();

  tools.forEach((tool, index) => {
    if (tool.type !== "mcp" || tool.value === undefined) return;
    referenced.add(tool.value);
    if (!declared.has(tool.value)) {
      issues.push({
        path: `dependencies.tools[${index}].value`,
        message: `names "${tool.value}", which the package declares no MCP server for`,
      });
    }
  });

  for (const name of declaredServerNames) {
    if (!referenced.has(name)) {
      issues.push({
        path: "dependencies.tools",
        message: `declares no dependency on the MCP server "${name}"`,
      });
    }
  }

  return issues;
}
