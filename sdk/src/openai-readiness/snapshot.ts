/**
 * The metadata snapshot a release is compared against.
 *
 * WHAT A SNAPSHOT IS FOR. The app-review lifecycle turns on one question: does
 * this version's contract still match the published one? Answering it needs
 * both sides captured in the same shape, so a comparison can be a pure function
 * of two objects rather than a live re-scan of a server that has since moved on.
 *
 * WHAT GOES IN IT is everything a rescan would re-read — tool names, titles,
 * descriptions, input and output schemas, annotations, security schemes, tool
 * `_meta` including UI references and visibility, the server's `instructions`,
 * and each UI resource's metadata and content security policy — plus the
 * server's ORIGIN, which decides the one case that is not a version bump at all.
 *
 * WHAT STAYS OUT is anything that varies between two reads of an unchanged
 * server: session ids, timestamps inside payloads, cursors. A snapshot that
 * moved on every capture would report drift on every comparison and be worth
 * nothing.
 *
 * Pure data. Safe from the browser entry.
 */

/** One tool, reduced to the parts a contract comparison is about. */
export interface OpenAIToolSnapshot {
  name: string;
  title?: string;
  description?: string;
  /** Canonical JSON of the input schema, so comparison is a string equality. */
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  securitySchemes?: unknown;
  /** Tool `_meta`, which carries the UI reference and visibility. */
  meta?: Record<string, unknown>;
}

/** One UI resource, reduced likewise. */
export interface OpenAIUiResourceSnapshot {
  uri: string;
  mimeType?: string;
  domain?: string;
  cspDomains?: string[];
}

export interface OpenAIMetadataSnapshot {
  /**
   * Scheme, host and port. NOT the path.
   *
   * The distinction is the whole reason this is a separate field: an origin
   * change is a NEW PLUGIN and a path change is an ordinary version bump, and
   * storing one URL would make the two indistinguishable.
   */
  origin: string;
  /** The endpoint path, which may change within one plugin. */
  path?: string;
  /** The server's `instructions`, which the model reads. */
  instructions?: string;
  tools: OpenAIToolSnapshot[];
  uiResources: OpenAIUiResourceSnapshot[];
  /** When this snapshot was captured. ISO-8601. */
  capturedAt?: string;
}

/**
 * Split a URL into the origin and path a comparison needs.
 *
 * Returns the raw string as the origin when it does not parse, so a malformed
 * URL compares unequal to everything rather than silently equal to another
 * malformed one.
 */
export function splitEndpoint(url: string): { origin: string; path: string } {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: parsed.pathname.replace(/\/$/, "") };
  } catch {
    return { origin: url, path: "" };
  }
}

/**
 * Build a snapshot from what a scan observed.
 *
 * Deliberately takes plain objects rather than a client: capturing is
 * mechanical, and a function that needed a transport could not be used to build
 * the PUBLISHED side, which by definition was captured on another day.
 */
export function captureOpenAIMetadataSnapshot(input: {
  endpointUrl: string;
  instructions?: string;
  tools?: readonly {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
    securitySchemes?: unknown;
    _meta?: Record<string, unknown>;
  }[];
  uiResources?: readonly {
    uri: string;
    mimeType?: string;
    domain?: string;
    declaredCspDomains?: string[];
  }[];
  capturedAt?: string;
}): OpenAIMetadataSnapshot {
  const { origin, path } = splitEndpoint(input.endpointUrl);
  return {
    origin,
    path,
    instructions: input.instructions,
    // SORTED, both here and for CSP domains below. Two scans of one server are
    // free to list tools in different orders, and a comparison that treated
    // order as contract would report drift on an unchanged server.
    tools: [...(input.tools ?? [])]
      .map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        securitySchemes: tool.securitySchemes,
        meta: tool._meta,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    uiResources: [...(input.uiResources ?? [])]
      .map((resource) => ({
        uri: resource.uri,
        mimeType: resource.mimeType,
        domain: resource.domain,
        cspDomains: resource.declaredCspDomains
          ? [...resource.declaredCspDomains].sort()
          : undefined,
      }))
      .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0)),
    capturedAt: input.capturedAt,
  };
}
