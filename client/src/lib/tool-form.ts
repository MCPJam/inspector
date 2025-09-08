export interface FormField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  value: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
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
  const required = schema.required || [];
  Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
    const fieldType = prop.enum ? "enum" : prop.type || "string";
    fields.push({
      name: key,
      type: fieldType,
      description: prop.description,
      required: required.includes(key),
      value: getDefaultValue(fieldType, prop.enum),
      enum: prop.enum,
      minimum: prop.minimum,
      maximum: prop.maximum,
      pattern: prop.pattern,
    });
  });
  return fields;
}

export function applyParametersToFields(
  fields: FormField[],
  params: Record<string, any>,
): FormField[] {
  return fields.map((field) => {
    if (Object.prototype.hasOwnProperty.call(params, field.name)) {
      const raw = params[field.name];
      if (field.type === "array" || field.type === "object") {
        return { ...field, value: JSON.stringify(raw, null, 2) };
      }
      return { ...field, value: raw };
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
    const shouldInclude =
      field.required ||
      (field.value !== "" && field.value !== null && field.value !== undefined);
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
