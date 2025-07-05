export type JsonValue = string | number | boolean | null | undefined | JsonValue[] | {
    [key: string]: JsonValue;
};
export type JsonSchemaType = {
    type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
    title?: string;
    description?: string;
    required?: boolean | string[];
    default?: JsonValue;
    properties?: Record<string, JsonSchemaType>;
    items?: JsonSchemaType;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    enum?: string[];
    enumNames?: string[];
};
export type JsonObject = {
    [key: string]: JsonValue;
};
export type DataType = "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function" | "array" | "null";
export declare function getDataType(value: JsonValue): DataType;
export declare function tryParseJson(str: string): {
    success: boolean;
    data: JsonValue;
};
/**
 * Updates a value at a specific path in a nested JSON structure
 * @param obj The original JSON value
 * @param path Array of keys/indices representing the path to the value
 * @param value The new value to set
 * @returns A new JSON value with the updated path
 */
export declare function updateValueAtPath(obj: JsonValue, path: string[], value: JsonValue): JsonValue;
/**
 * Gets a value at a specific path in a nested JSON structure
 * @param obj The JSON value to traverse
 * @param path Array of keys/indices representing the path to the value
 * @param defaultValue Value to return if path doesn't exist
 * @returns The value at the path, or defaultValue if not found
 */
export declare function getValueAtPath(obj: JsonValue, path: string[], defaultValue?: JsonValue): JsonValue;
