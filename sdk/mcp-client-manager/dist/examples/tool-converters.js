import { CallToolResultSchema, } from "@modelcontextprotocol/sdk/types.js";
import { dynamicTool, jsonSchema, tool as defineTool, } from "ai";
const ensureJsonSchemaObject = (schema) => {
    var _a;
    if (schema && typeof schema === "object") {
        const record = schema;
        const base = record.jsonSchema
            ? ensureJsonSchemaObject(record.jsonSchema)
            : record;
        // Many MCP tools omit the top-level type; Anthropic requires an object schema.
        if (!("type" in base) || base.type === undefined) {
            base.type = "object";
        }
        if (base.type === "object") {
            base.properties = ((_a = base.properties) !== null && _a !== void 0 ? _a : {});
            if (base.additionalProperties === undefined) {
                base.additionalProperties = false;
            }
        }
        return base;
    }
    return {
        type: "object",
        properties: {},
        additionalProperties: false,
    };
};
export async function convertMCPToolsToVercelTools(listToolsResult, { schemas = "automatic", callTool, }) {
    var _a, _b;
    const tools = {};
    for (const toolDescription of listToolsResult.tools) {
        const { name, description, inputSchema } = toolDescription;
        const execute = async (args, options) => {
            var _a, _b;
            (_b = (_a = options === null || options === void 0 ? void 0 : options.abortSignal) === null || _a === void 0 ? void 0 : _a.throwIfAborted) === null || _b === void 0 ? void 0 : _b.call(_a);
            const result = await callTool({ name, args, options });
            return CallToolResultSchema.parse(result);
        };
        let vercelTool;
        if (schemas === "automatic") {
            const normalizedInputSchema = ensureJsonSchemaObject(inputSchema);
            vercelTool = dynamicTool({
                description,
                inputSchema: jsonSchema({
                    type: "object",
                    properties: (_a = normalizedInputSchema.properties) !== null && _a !== void 0 ? _a : {},
                    additionalProperties: (_b = normalizedInputSchema.additionalProperties) !== null && _b !== void 0 ? _b : false,
                }),
                execute,
            });
        }
        else {
            const overrides = schemas;
            if (!(name in overrides)) {
                // If overrides are provided, only include tools explicitly listed
                continue;
            }
            vercelTool = defineTool({
                description,
                inputSchema: overrides[name].inputSchema,
                execute,
            });
        }
        tools[name] = vercelTool;
    }
    return tools;
}
