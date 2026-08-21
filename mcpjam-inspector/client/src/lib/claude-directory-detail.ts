/**
 * Parse the upstream directory row behind a catalog entry into the shape the
 * detail dialog renders.
 *
 * `serverCatalogQueries:getCatalogServer` returns the row as the canonical
 * JSON STRING the backend stores (`rawJson`) — Convex cannot return
 * `$`-prefixed keys, so the text travels and the consumer parses. The row is
 * a `.passthrough()` capture of Anthropic's directory BFF: only four fields
 * are contractual upstream, so every read here is defensive and every miss is
 * an omission, never a placeholder. Absence is semantic — the dialog renders
 * only sections that exist.
 *
 * Deliberately NOT surfaced:
 *   html_content — upstream HTML; rendering it would be an XSS handed to
 *     whoever edits a directory listing. The plain-text `description` carries
 *     the same content.
 *   popularity/trending/rank — excluded from content hashing upstream
 *     (VOLATILE_ROW_FIELDS), so the stored copy is a stale snapshot from the
 *     row's last substantive change, not a live number.
 */

/** A link the dialog may render as an anchor. Always https (see safeUrl). */
export interface DirectoryDetailLink {
  label: string;
  url: string;
}

/** `remote.required_fields[]`: something the user must supply to connect. */
export interface DirectoryRequiredField {
  field: string;
  sourceUrl?: string;
}

export interface DirectoryServerDetail {
  /** The long-form description; the card only carries the one-liner. */
  description?: string;
  authorName?: string;
  /** The author's site, if it is an https URL. */
  authorUrl?: string;
  categories: string[];
  toolNames: string[];
  promptNames: string[];
  /** Upstream free text, e.g. "Read and write". */
  permissions?: string;
  sensitiveDataTypes: string[];
  /** Documentation / support / privacy / directory listing, https-only. */
  links: DirectoryDetailLink[];
  /** "auth_required" | "no_auth" as published; absent when upstream is silent. */
  authPosture?: string;
  requiredFields: DirectoryRequiredField[];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

/**
 * An https URL or nothing. The row crossed two wires (Anthropic's BFF, then
 * our mirror) and these values become clickable hrefs — the same https-only
 * posture the ETL applies to `icon_url` applies here, and it also drops the
 * upstream rows whose "URL" fields hold plain strings or MCP endpoints.
 */
function safeUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function requiredFields(value: unknown): DirectoryRequiredField[] {
  if (!Array.isArray(value)) return [];
  const fields: DirectoryRequiredField[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const field = asString(record.field);
    if (!field) continue;
    fields.push({ field, sourceUrl: safeUrl(record.source_url) });
  }
  return fields;
}

/**
 * The detail view of one upstream row, or `null` when the text is not a JSON
 * object. `null` means "show the summary the card already had", never an
 * error state — the row is real, only its body failed to arrive.
 */
export function parseDirectoryServerDetail(
  rawJson: string | null | undefined
): DirectoryServerDetail | null {
  if (!rawJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const author = (row.author ?? {}) as Record<string, unknown>;
  const remote = (row.remote ?? {}) as Record<string, unknown>;

  const links: DirectoryDetailLink[] = [];
  const pushLink = (label: string, value: unknown) => {
    const url = safeUrl(value);
    if (url) links.push({ label, url });
  };
  pushLink("Documentation", row.documentation);
  pushLink("Support", row.support);
  pushLink("Privacy policy", row.privacy_policy);
  pushLink("View in Claude directory", row.directory_url);

  return {
    description: asString(row.description),
    authorName:
      typeof author === "object" && author !== null
        ? asString(author.name)
        : undefined,
    authorUrl:
      typeof author === "object" && author !== null
        ? safeUrl(author.url)
        : undefined,
    categories: asStringArray(row.categories),
    toolNames: asStringArray(row.tool_names),
    promptNames: asStringArray(row.prompt_names),
    permissions: asString(row.permissions),
    sensitiveDataTypes: asStringArray(row.sensitive_data_types),
    links,
    authPosture:
      typeof remote === "object" && remote !== null
        ? asString(remote.auth_posture)
        : undefined,
    requiredFields:
      typeof remote === "object" && remote !== null
        ? requiredFields(remote.required_fields)
        : [],
  };
}
