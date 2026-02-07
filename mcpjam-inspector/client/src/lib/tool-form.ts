export interface FormField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  value: any;
  enum?: string[];
  enumLabels?: string[]; // Display labels for enum values (from oneOf/anyOf titles)
  minimum?: number;
  maximum?: number;
  pattern?: string;
  isSet: boolean;
}

/**
 * Resolve a $ref reference in a JSON schema.
 * Handles local references like "#/$defs/CategoryName"
 */
function resolveRef(ref: string, rootSchema: any): any | null {
  if (!ref.startsWith("#/")) return null;

  const path = ref.slice(2).split("/"); // Remove "#/" and split
  let current = rootSchema;

  for (const segment of path) {
    if (current && typeof current === "object" && segment in current) {
      current = current[segment];
    } else {
      return null;
    }
  }

  return current;
}

/**
 * Normalize a type value that may be a string or an array (e.g. ["number", "null"]).
 * Returns the first non-null type string, or null if none found.
 */
function normalizeType(type: any): string | null {
  if (Array.isArray(type)) {
    return type.find((t: string) => t !== "null") || null;
  }
  return typeof type === "string" ? type : null;
}

/**
 * Resolve the effective type of a property, handling composition keywords.
 * Looks inside anyOf/oneOf/allOf/$ref when there's no top-level `type`.
 * Tracks visited $refs to prevent infinite recursion on cyclic schemas.
 */
function resolvePropertyType(
  prop: any,
  rootSchema: any,
  visitedRefs: Set<string> = new Set(),
): string {
  // Direct type
  if (prop.type) {
    return normalizeType(prop.type) || "string";
  }

  // $ref — resolve and recurse (with cycle detection)
  if (prop.$ref) {
    if (visitedRefs.has(prop.$ref)) return "string";
    visitedRefs.add(prop.$ref);
    const resolved = resolveRef(prop.$ref, rootSchema);
    if (resolved) return resolvePropertyType(resolved, rootSchema, visitedRefs);
  }

  // anyOf / oneOf — find first non-null type
  const options = prop.anyOf || prop.oneOf;
  if (Array.isArray(options)) {
    for (const opt of options) {
      const optType = normalizeType(opt.type);
      if (optType === "null") continue;
      if (optType) return optType;
      if (opt.$ref) {
        if (visitedRefs.has(opt.$ref)) continue;
        visitedRefs.add(opt.$ref);
        const resolved = resolveRef(opt.$ref, rootSchema);
        if (resolved)
          return resolvePropertyType(resolved, rootSchema, visitedRefs);
      }
    }
  }

  // allOf — find first entry with a concrete type
  if (Array.isArray(prop.allOf)) {
    for (const sub of prop.allOf) {
      const t = resolvePropertyType(sub, rootSchema, visitedRefs);
      if (t !== "string") return t;
    }
  }

  return "string";
}

/**
 * Extract enum values from oneOf/anyOf with const pattern.
 * This is commonly used by some Python MCP servers for enum types.
 * Returns { values, labels } where labels may have custom titles.
 */
function extractEnumFromOneOfAnyOf(prop: any): {
  values: string[];
  labels: string[];
} | null {
  const options = prop.oneOf || prop.anyOf;
  if (!Array.isArray(options)) return null;

  // Filter options that have a 'const' property (enum pattern)
  const constOptions = options.filter(
    (opt: any) => opt && typeof opt === "object" && "const" in opt,
  );

  if (constOptions.length === 0) return null;

  const values: string[] = [];
  const labels: string[] = [];

  for (const opt of constOptions) {
    const val = String(opt.const);
    values.push(val);
    // Use title if available, otherwise use the value itself
    labels.push(opt.title ?? val);
  }

  return { values, labels };
}

/**
 * Extract enum information from a property, handling multiple schema patterns:
 * 1. Direct enum array: { enum: ["a", "b", "c"] }
 * 2. $ref to $defs: { $ref: "#/$defs/MyEnum" } where $defs.MyEnum.enum exists
 * 3. oneOf/anyOf with const: { oneOf: [{ const: "a", title: "A" }, ...] }
 */
function extractEnumFromProperty(
  prop: any,
  rootSchema: any,
): { values: string[]; labels?: string[] } | null {
  // Pattern 1: Direct enum array
  if (prop.enum) {
    const labels = Array.isArray(prop.enumNames) ? prop.enumNames : undefined;
    return { values: prop.enum, labels };
  }

  // Pattern 2: $ref to $defs (common with Pydantic/FastMCP)
  if (prop.$ref && typeof prop.$ref === "string") {
    const resolved = resolveRef(prop.$ref, rootSchema);
    if (resolved?.enum) {
      return { values: resolved.enum };
    }
    // Also check for oneOf/anyOf in the resolved schema
    if (resolved) {
      const extracted = extractEnumFromOneOfAnyOf(resolved);
      if (extracted) return extracted;
    }
  }

  // Pattern 3: oneOf/anyOf with const values
  const extracted = extractEnumFromOneOfAnyOf(prop);
  if (extracted) return extracted;

  return null;
}

export function getDefaultValue(type: string, enumValues?: string[]) {
  switch (type) {
    case "enum":
      return enumValues?.[0] || "";
    case "string":
      return "";
    case "number":
    case "integer":
      return "";
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "";
  }
}

export function generateFormFieldsFromSchema(schema: any): FormField[] {
  if (!schema || !schema.properties) return [];
  const fields: FormField[] = [];
  const requiredFields: string[] = schema.required || [];
  Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
    // Check for enum values - supports multiple patterns including $ref to $defs
    let enumValues: string[] | undefined;
    let enumLabels: string[] | undefined;

    const extracted = extractEnumFromProperty(prop, schema);
    if (extracted) {
      enumValues = extracted.values;
      enumLabels = extracted.labels;
    }

    const fieldType = enumValues ? "enum" : resolvePropertyType(prop, schema);
    const isRequired = requiredFields.includes(key);

    // Start with type-based default value
    let value = getDefaultValue(fieldType, enumValues);
    // Required fields are considered "set" by default, optional fields are unset
    let isSet = isRequired;

    // If the schema provides a default, respect it and mark the field as set
    if (prop.default !== undefined) {
      if (fieldType === "array" || fieldType === "object") {
        value = JSON.stringify(prop.default, null, 2);
      } else {
        value = prop.default;
      }
      isSet = true;
    }

    fields.push({
      name: key,
      type: fieldType,
      description: prop.description,
      required: isRequired,
      value,
      enum: enumValues,
      enumLabels,
      minimum: prop.minimum,
      maximum: prop.maximum,
      pattern: prop.pattern,
      isSet,
    });
  });
  return fields;
}

export function applyParametersToFields(
  fields: FormField[],
  params: Record<string, any>,
): FormField[] {
  return fields.map((field) => {
    if (Object.hasOwn(params, field.name)) {
      const raw = params[field.name];
      if (field.type === "array" || field.type === "object") {
        return {
          ...field,
          value: JSON.stringify(raw, null, 2),
          isSet: true,
        };
      }
      return { ...field, value: raw, isSet: true };
    }
    return field;
  });
}

export function buildParametersFromFields(
  fields: FormField[],
  warn?: (msg: string, ctx?: any) => void,
): Record<string, any> {
  const params: Record<string, any> = {};
  fields.forEach((field) => {
    const isSet = field.isSet ?? field.required ?? false;
    const hasNonEmptyValue =
      field.value !== "" && field.value !== null && field.value !== undefined;

    const shouldInclude = field.required || (isSet && hasNonEmptyValue);
    if (!shouldInclude) return;

    let processedValue = field.value;
    try {
      if (field.type === "number" || field.type === "integer") {
        processedValue = Number(field.value);
        if (isNaN(processedValue)) {
          warn?.("Invalid number value for field", {
            fieldName: field.name,
            value: field.value,
          });
        }
      } else if (field.type === "boolean") {
        processedValue = Boolean(field.value);
      } else if (field.type === "array" || field.type === "object") {
        processedValue = JSON.parse(field.value);
      }
      params[field.name] = processedValue;
    } catch (parseError) {
      warn?.("Failed to process field value", {
        fieldName: field.name,
        type: field.type,
        value: field.value,
        error: parseError,
      });
      params[field.name] = field.value;
    }
  });
  return params;
}
