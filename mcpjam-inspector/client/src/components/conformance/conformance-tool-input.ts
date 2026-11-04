import Ajv from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

/** An automatic task call sends {}, so its schema must accept that value. */
export function acceptsEmptyToolArguments(
  schema: Record<string, unknown> | undefined,
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
    return ajv.compile(schema)({}) === true;
  } catch {
    // An unsupported schema cannot establish that an automatic call is ready.
    return false;
  }
}
