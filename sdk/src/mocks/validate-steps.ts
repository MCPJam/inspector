import {
  MAX_CASE_DELAY_MS,
  MAX_CASE_STEPS,
  MAX_COMPLETION_VALUES,
  MAX_SAMPLE_TOKENS,
  MAX_STEP_DELAY_MS,
} from "./definition-types.js";
import type { MockIssueCode } from "./validate-definition.js";

/**
 * The shape checks for a saved case's `steps` and `task`, and for the
 * definition's `completions`, called by the definition validator. Each message
 * says what to change.
 */

type Obj = Record<string, unknown>;
type Add = (code: MockIssueCode, path: string, message: string) => void;

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const at = (path: string, key: string) => `${path}.${key}`;

const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];
const STEP_FIELDS: Record<string, string[]> = {
  progress: ["kind", "delayMs", "progress", "total", "message"],
  log: ["kind", "delayMs", "level", "data", "logger"],
  listChanged: ["kind", "delayMs", "list"],
  resourceUpdated: ["kind", "delayMs", "uri"],
  ask: ["kind", "delayMs", "id", "message", "requestedSchema"],
  askUrl: ["kind", "delayMs", "id", "message", "url"],
  sample: ["kind", "delayMs", "id", "prompt", "systemPrompt", "maxTokens"],
};
const LISTS = ["tools", "prompts", "resources"];
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export function checkCaseSteps(savedCase: Obj, path: string, add: Add): void {
  if ("task" in savedCase && savedCase.task !== true) {
    add(
      "invalid_value",
      at(path, "task"),
      `${at(path, "task")} must be true. Remove it to answer in place.`
    );
  }
  if (!("steps" in savedCase)) return;
  const steps = savedCase.steps;
  const stepsPath = at(path, "steps");
  if (!Array.isArray(steps) || steps.length === 0) {
    add(
      "invalid_type",
      stepsPath,
      `${stepsPath} must be a list with at least one step. Remove it for a case that only answers.`
    );
    return;
  }
  if (steps.length > MAX_CASE_STEPS) {
    add(
      "invalid_value",
      stepsPath,
      `A case may have ${MAX_CASE_STEPS} steps at most. Split the work across cases.`
    );
    return;
  }
  const ids = new Set<string>();
  let totalDelay = 0;
  steps.forEach((step, i) => {
    const p = at(stepsPath, String(i));
    if (!isObj(step)) {
      add("invalid_type", p, `${p} must be an object.`);
      return;
    }
    totalDelay += checkStep(step, p, ids, add);
  });
  if (totalDelay > MAX_CASE_DELAY_MS) {
    add(
      "invalid_value",
      stepsPath,
      `The steps of a case may wait ${MAX_CASE_DELAY_MS} ms in all. Shorten a delayMs.`
    );
  }
}

/** Checks one step and returns its delay. */
function checkStep(step: Obj, p: string, ids: Set<string>, add: Add): number {
  const kind = step.kind;
  const allowed = typeof kind === "string" ? STEP_FIELDS[kind] : undefined;
  if (!allowed) {
    add(
      "invalid_value",
      at(p, "kind"),
      `${at(p, "kind")} must be one of ${Object.keys(STEP_FIELDS).join(", ")}, not ${JSON.stringify(kind)}.`
    );
    return 0;
  }
  for (const key of Object.keys(step)) {
    if (!allowed.includes(key)) {
      add(
        "unknown_field",
        at(p, key),
        `Unknown field "${key}" at ${p}. Allowed fields for ${kind}: ${allowed.join(", ")}.`
      );
    }
  }
  const text = (key: string, required: boolean) => {
    if (!(key in step)) {
      if (required)
        add("invalid_type", at(p, key), `${at(p, key)} is required.`);
      return;
    }
    if (typeof step[key] !== "string" || (required && step[key] === "")) {
      add(
        "invalid_type",
        at(p, key),
        `${at(p, key)} must be ${required ? "a non-empty " : "a "}string.`
      );
    }
  };
  const number = (key: string, required: boolean, max?: number) => {
    if (!(key in step)) {
      if (required)
        add("invalid_type", at(p, key), `${at(p, key)} is required.`);
      return;
    }
    const value = step[key];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (max !== undefined && value > max)
    ) {
      add(
        "invalid_value",
        at(p, key),
        `${at(p, key)} must be a number from 0${max === undefined ? "" : ` to ${max}`}.`
      );
    }
  };
  let delay = 0;
  if ("delayMs" in step) {
    number("delayMs", false, MAX_STEP_DELAY_MS);
    if (typeof step.delayMs === "number") delay = step.delayMs;
  }
  if (kind === "progress") {
    number("progress", true);
    number("total", false);
    text("message", false);
  } else if (kind === "listChanged") {
    if (!LISTS.includes(step.list as string)) {
      add(
        "invalid_value",
        at(p, "list"),
        `${at(p, "list")} must be one of ${LISTS.join(", ")}.`
      );
    }
  } else if (kind === "resourceUpdated") {
    text("uri", true);
  } else if (kind === "log") {
    if (!LOG_LEVELS.includes(step.level as string)) {
      add(
        "invalid_value",
        at(p, "level"),
        `${at(p, "level")} must be one of ${LOG_LEVELS.join(", ")}.`
      );
    }
    if (!("data" in step))
      add("invalid_type", at(p, "data"), `${at(p, "data")} is required.`);
    text("logger", false);
  } else {
    if (typeof step.id !== "string" || !ID_PATTERN.test(step.id)) {
      add(
        "invalid_value",
        at(p, "id"),
        `${at(p, "id")} must start with a letter and use letters, digits, "_" or "-" (64 at most), since the result reads the reply by it.`
      );
    } else if (ids.has(step.id)) {
      add(
        "invalid_value",
        at(p, "id"),
        `Two steps use the id "${step.id}". Give each question its own id.`
      );
    } else {
      ids.add(step.id);
    }
    if (kind === "ask") {
      text("message", true);
      if (
        !isObj(step.requestedSchema) ||
        step.requestedSchema.type !== "object" ||
        !isObj(step.requestedSchema.properties)
      ) {
        add(
          "invalid_value",
          at(p, "requestedSchema"),
          `${at(p, "requestedSchema")} must be an object schema with "properties", as a form question needs.`
        );
      }
    } else if (kind === "askUrl") {
      text("message", true);
      text("url", true);
      if (typeof step.url === "string" && !/^https?:\/\//i.test(step.url)) {
        add(
          "invalid_value",
          at(p, "url"),
          `${at(p, "url")} must start with http:// or https://.`
        );
      }
    } else {
      text("prompt", true);
      text("systemPrompt", false);
      number("maxTokens", true, MAX_SAMPLE_TOKENS);
    }
  }
  return delay;
}

/** `completions`: prompt names and template URIs mapped to argument names and their suggestions. */
export function checkCompletions(definition: Obj, add: Add): void {
  if (!("completions" in definition)) return;
  const completions = definition.completions;
  if (!isObj(completions)) {
    add("invalid_type", "completions", "completions must be an object.");
    return;
  }
  for (const key of Object.keys(completions)) {
    if (key !== "prompts" && key !== "resourceTemplates") {
      add(
        "unknown_field",
        at("completions", key),
        `Unknown field "${key}" at completions. Allowed fields: prompts, resourceTemplates.`
      );
    }
  }
  for (const family of ["prompts", "resourceTemplates"]) {
    const entries = completions[family];
    if (entries === undefined) continue;
    const familyPath = at("completions", family);
    if (!isObj(entries)) {
      add("invalid_type", familyPath, `${familyPath} must be an object.`);
      continue;
    }
    for (const [name, args] of Object.entries(entries)) {
      const p = at(familyPath, name);
      if (!isObj(args)) {
        add(
          "invalid_type",
          p,
          `${p} must map each argument name to its list of suggestions.`
        );
        continue;
      }
      for (const [arg, values] of Object.entries(args)) {
        const vp = at(p, arg);
        if (
          !Array.isArray(values) ||
          !values.every((v) => typeof v === "string")
        ) {
          add("invalid_type", vp, `${vp} must be a list of strings.`);
        } else if (values.length > MAX_COMPLETION_VALUES) {
          add(
            "invalid_value",
            vp,
            `An argument may list ${MAX_COMPLETION_VALUES} suggestions at most. Keep the likeliest ones.`
          );
        }
      }
    }
  }
}
