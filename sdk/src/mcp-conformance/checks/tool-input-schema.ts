import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { supportedJsonSchemaDialect } from "../../mcp-client-manager/dialect-dispatch-json-schema-validator.js";
import { errorMessage } from "./helpers.js";

const options = { strict: false, validateFormats: false } as const;
const draft2020 = new Ajv2020(options);
const draft07 = new Ajv(options);

export function checkToolInputSchema(
  schema: Record<string, unknown>,
): { status: "invalid" | "unsupported"; reason: string } | undefined {
  const declared = schema.$schema;
  if (declared !== undefined && typeof declared !== "string") {
    return { status: "invalid", reason: "inputSchema.$schema is not a string" };
  }

  const dialect = supportedJsonSchemaDialect(declared);
  if (dialect === undefined) {
    return {
      status: "unsupported",
      reason: `inputSchema declares unsupported JSON Schema dialect ${declared}`,
    };
  }

  const validator = dialect === "draft2020" ? draft2020 : draft07;
  const metaSchema =
    dialect === "draft2020"
      ? "https://json-schema.org/draft/2020-12/schema"
      : "http://json-schema.org/draft-07/schema#";
  if (validator.validate(metaSchema, schema) !== true) {
    return {
      status: "invalid",
      reason: validator.errorsText(validator.errors, { dataVar: "inputSchema" }),
    };
  }

  if (!JSON.stringify(schema).includes('"$ref":')) return undefined;

  // Resolve references synchronously, without a schema loader. Each tool gets
  // its own resolver so another tool's $id cannot satisfy its references.
  const resolutionOptions = { ...options, validateSchema: false };
  try {
    if (dialect === "draft2020") {
      new Ajv2020(resolutionOptions).compile(schema);
    } else {
      new Ajv(resolutionOptions).compile(schema);
    }
    return undefined;
  } catch (error) {
    return {
      status: "unsupported",
      reason: `inputSchema references could not be checked locally: ${errorMessage(error)}`,
    };
  }
}
