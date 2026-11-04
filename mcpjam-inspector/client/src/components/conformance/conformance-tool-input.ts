import Ajv from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

/** Check tool arguments using the dialect declared by the tool. */
export function acceptsToolArguments(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!schema || schema.$async === true) return false;
  try {
    const dialect =
      typeof schema.$schema === "string"
        ? schema.$schema.replace(/#$/, "")
        : undefined;
    // Follow the declared dialect; MCP defaults to 2020-12. Each call gets
    // its own cache so refetched schemas cannot collide on the same $id.
    const ajv =
      dialect === "http://json-schema.org/draft-07/schema" ||
      dialect === "https://json-schema.org/draft-07/schema"
        ? new Ajv({ strict: false })
        : new Ajv2020({ strict: false });
    return ajv.compile(schema)(args) === true;
  } catch {
    // An unsupported schema cannot establish that the tool arguments are ready.
    return false;
  }
}

/** An automatic task call sends {}, so its schema must accept that value. */
export function acceptsEmptyToolArguments(
  schema: Record<string, unknown> | undefined,
): boolean {
  return acceptsToolArguments(schema, {});
}
