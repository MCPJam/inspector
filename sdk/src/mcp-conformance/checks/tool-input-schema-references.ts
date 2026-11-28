type SchemaObject = Record<string, unknown>;
type Schema = SchemaObject | boolean;
type ResolveUri = (base: string, reference: string) => string;

export type SchemaIssue = { status: "invalid" | "unsupported"; reason: string };

const sharedSingleKeywords = [
  "additionalProperties",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "propertyNames",
];
const sharedMapKeywords = ["properties", "patternProperties", "definitions", "$defs"];
const sharedArrayKeywords = ["allOf", "anyOf", "oneOf"];
const dialectKeywords = {
  draft2020: {
    singles: [...sharedSingleKeywords, "unevaluatedItems", "unevaluatedProperties"],
    arrays: [...sharedArrayKeywords, "prefixItems"],
    maps: [...sharedMapKeywords, "dependentSchemas"],
    refs: ["$ref", "$dynamicRef"],
  },
  draft07: {
    singles: [...sharedSingleKeywords, "additionalItems"],
    arrays: sharedArrayKeywords,
    maps: [...sharedMapKeywords, "dependencies"],
    refs: ["$ref"],
  },
};

function isObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function* subschemas(
  schema: SchemaObject,
  dialect: keyof typeof dialectKeywords,
): Iterable<unknown> {
  const keywords = dialectKeywords[dialect];
  for (const key of keywords.singles) yield schema[key];
  yield* Array.isArray(schema.items) && dialect === "draft07" ? schema.items : [schema.items];

  for (const key of keywords.arrays) {
    const children = schema[key];
    if (Array.isArray(children)) yield* children;
  }

  for (const key of keywords.maps) {
    const children = schema[key];
    if (isObject(children)) yield* Object.values(children);
  }
}

function documentUri(uri: string): string {
  return uri.split("#", 1)[0];
}

function pointerTarget(schema: SchemaObject, pointer: string): unknown {
  let value: unknown = schema;
  for (const part of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(part)) return undefined;
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      value = value[Number(key)];
    } else if (isObject(value) && Object.hasOwn(value, key)) {
      value = value[key];
    } else {
      return undefined;
    }
  }
  return value;
}

export function checkSchemaReferences(
  root: SchemaObject,
  dialect: keyof typeof dialectKeywords,
  resolve: ResolveUri,
  validationError: (schema: Schema) => string | undefined,
): SchemaIssue | undefined {
  const resources = new Map<string, SchemaObject>();
  const anchors = new Map<string, SchemaObject>();
  const refs: Array<{ uri: string; value: string; keyword: string }> = [];

  function visit(schema: unknown, parentUri: string, isRoot = false): void {
    if (!isObject(schema)) return;
    const id = typeof schema.$id === "string"
      ? resolve(parentUri, schema.$id)
      : undefined;
    const uri = documentUri(id ?? parentUri);
    if (isRoot || id === uri || id === `${uri}#`) resources.set(uri, schema);
    if (id !== undefined && id !== uri && id !== `${uri}#`) anchors.set(id, schema);

    if (dialect === "draft2020") {
      for (const anchor of [schema.$anchor, schema.$dynamicAnchor]) {
        if (typeof anchor === "string") anchors.set(`${uri}#${anchor}`, schema);
      }
    }
    for (const keyword of dialectKeywords[dialect].refs) {
      const value = schema[keyword];
      if (typeof value === "string") refs.push({ uri, value, keyword });
    }
    for (const child of subschemas(schema, dialect)) visit(child, uri);
  }

  visit(root, "", true);

  // Metaschema validation handles keyword values. Reference lookup uses the
  // submitted document only and does not run Ajv's instance compiler.
  const validated = new Set<Schema>([root]);
  let unavailable: SchemaIssue | undefined;
  for (const { uri, value, keyword } of refs) {
    const absolute = resolve(uri, value);
    const document = documentUri(absolute);
    const resource = resources.get(document);
    const encodedFragment = absolute.slice(document.length + 1);
    let fragment: string;
    try {
      fragment = decodeURIComponent(encodedFragment);
    } catch {
      return {
        status: "invalid",
        reason: `inputSchema ${keyword} ${JSON.stringify(value)} has an invalid fragment`,
      };
    }
    if (!resource) {
      unavailable ??= {
        status: "unsupported",
        reason: `inputSchema ${keyword} ${JSON.stringify(value)} refers to a schema that is unavailable locally`,
      };
      continue;
    }
    const target = !fragment
      ? resource
      : fragment.startsWith("/")
        ? pointerTarget(resource, fragment)
        : anchors.get(`${document}#${fragment}`);
    if (!isObject(target) && typeof target !== "boolean") {
      return {
        status: "invalid",
        reason: `inputSchema ${keyword} ${JSON.stringify(value)} has no target schema in the local document`,
      };
    }
    if (!validated.has(target)) {
      const error = validationError(target);
      if (error) {
        return { status: "invalid", reason: `inputSchema ${keyword} ${JSON.stringify(value)}: ${error}` };
      }
      validated.add(target);
    }
  }
  return unavailable;
}
