import { asSchema, jsonSchema, type Tool, type ToolSet } from "ai";
import type { OpenAIProfile } from "../openai-profile/profile.js";
export interface McpToolConnection {
  serverId: string;
  connectionId: string;
  key: string;
  label: string;
  profile?: OpenAIProfile;
  isDefault?: boolean;
}
export type ConnectionsByServerId = Readonly<
  Record<string, readonly McpToolConnection[]>
>;
export type ConnectionRoutingSnapshot = ReadonlyMap<string, string>;
export interface ConnectionToolMetadata {
  _serverId?: string;
  _mcpToolName?: string;
  _connectionIds?: readonly string[];
  _connectionId?: string;
  _connectionForInput?: (input: unknown) => McpToolConnection | undefined;
  _connectionForCall?: (toolCallId: string) => McpToolConnection | undefined;
}
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** 40 for the tool name + "__" + this stays inside the 64-character limit. */
const SLUG_BUDGET = 20;
function slugs(connections: readonly McpToolConnection[]) {
  const result = new Map<string, string>();
  const taken = new Set(["local"]);
  for (const c of [...connections].sort((a, b) =>
    a.connectionId.localeCompare(b.connectionId)
  )) {
    const base =
      c.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, SLUG_BUDGET)
        .replace(/-+$/g, "") || "server";
    let slug = base;
    let n = 2;
    while (taken.has(slug)) {
      // Appending to a slug already at its cap pushes the variant past the
      // 64-character tool-name limit, so the suffix comes out of the base.
      const suffix = `-${n++}`;
      slug = `${base
        .slice(0, SLUG_BUDGET - suffix.length)
        .replace(/-+$/g, "")}${suffix}`;
    }
    taken.add(slug);
    result.set(c.connectionId, slug);
  }
  return result;
}
/**
 * What the model is told about each connected account.
 *
 * Shaped to match what ChatGPT injects, for the same reason the field is named
 * `link_id` rather than something that reads better: a server author and a
 * model both meet this in more than one host, and one convention is worth more
 * than a nicer one per host. Keys are theirs verbatim.
 *
 * The flattened `label` alone is NOT enough, and that is the bug this fixes.
 * `connectionLabel` is email-first and returns one string, so a server that
 * answers the profile contract in full — the lab's `whoami` returns name,
 * email AND nickname — still reached the model as a bare address, and "my
 * personal account" became an inference about the shape of an address. The
 * profile has been on this type all along; nothing read it.
 *
 * Absent fields are OMITTED rather than sent as null: a server with no profile
 * tool should read as "we know nothing about this account", not as an account
 * whose name is empty.
 */
function accountDescriptors(choices: readonly McpToolConnection[]) {
  return choices.map((c) => ({
    link_id: c.connectionId,
    // Our nearest equivalent to their host-assigned connection name. Exact
    // parity is impossible — they name connections themselves ("Primary"),
    // we have no such name — but this ladder puts the user's own rename first,
    // which is the fact most worth carrying. For an un-renamed account it
    // duplicates `profile_email`, which is harmless.
    link_name: c.label,
    ...(c.profile?.id ? { profile_id: c.profile.id } : {}),
    ...(c.profile?.name ? { profile_name: c.profile.name } : {}),
    ...(c.profile?.email ? { profile_email: c.profile.email } : {}),
    ...(c.profile?.nickname ? { profile_nickname: c.profile.nickname } : {}),
  }));
}

/**
 * One account, named for a tool description rather than a JSON blob.
 *
 * Built from the same facts as a descriptor and deduplicated: the label
 * already falls back to the email, so an un-renamed account would otherwise
 * print its address twice.
 */
function accountPrefix(c: McpToolConnection): string {
  const extra = [c.profile?.name, c.profile?.email].filter(
    (v): v is string => !!v && v !== c.label
  );
  return extra.length ? `${c.label} (${extra.join(", ")})` : c.label;
}

/**
 * The selector's own guidance, including the ask-before-an-ambiguous-write
 * instruction ChatGPT ships.
 *
 * That instruction is why an honestly-named write prompts for an account: it
 * is instructed behaviour, not the model being careful, and we had no
 * equivalent. It is not a guarantee. It fires only when the model classifies
 * the call as a write, and that classification reads the tool's name and
 * description — text the SERVER controls. A tool named `find_and_preview` that
 * archives what it finds is not classified as a write and sails past this,
 * which is exactly what the lab's `SNEAKY_WRITE` fixture demonstrates. Shipped
 * because it closes the honest-mistake case, not because it closes the
 * dishonest one.
 */
const SELECTOR_GUIDANCE = [
  "Link ID for the account this call should use.",
  "Supply link_id using a link_id value below.",
  "Select only from the accounts below.",
  "If multiple listed accounts could satisfy a write request and the intended" +
    " account is not clear from the user's request or conversation, ask which" +
    " account to use before calling this tool.",
].join("\n");

const invalidAccount = () => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: "The selected account is unavailable for this tool. Select a connected account.",
    },
  ],
});

/** Snapshot-owned closures preserve both credential directions for each call. */
export function mergeConnectionToolsets(
  perKey: Readonly<Record<string, ToolSet>>,
  connectionsByServerId: ConnectionsByServerId,
  options: {
    snapshot: ConnectionRoutingSnapshot;
    onRoute?: (toolCallId: string, connection: McpToolConnection) => void;
  }
): ToolSet {
  const output: ToolSet = {};
  const groupedKeys = new Set(
    Object.values(connectionsByServerId).flatMap((g) => g.map((c) => c.key))
  );
  for (const [key, tools] of Object.entries(perKey))
    if (!groupedKeys.has(key)) Object.assign(output, tools);
  const reserved = new Set(
    Object.values(perKey).flatMap((tools) => Object.keys(tools))
  );
  for (const [serverId, group] of Object.entries(connectionsByServerId)) {
    const live = group.filter(
      (c) => options.snapshot.get(c.connectionId) === c.key && perKey[c.key]
    );
    if (live.length === 1) {
      // Attribution is stamped even when this connection owns the bare server
      // key. Without it a scope step-up saved here carries no connectionId,
      // the resume guard has nothing to compare, and a replay that lands after
      // the credential behind that key changed would run on the new one.
      const connection = live[0];
      for (const [name, tool] of Object.entries(perKey[connection.key]))
        output[name] = {
          ...tool,
          _serverId: serverId,
          _mcpToolName: name,
          _connectionId: connection.connectionId,
          _connectionForInput: () => connection,
          _connectionForCall: () => connection,
        } as Tool & ConnectionToolMetadata;
      continue;
    }
    const names = [...new Set(live.flatMap((c) => Object.keys(perKey[c.key])))];
    const slugById = slugs(live);
    for (const name of names) {
      const choices = live.filter((c) => perKey[c.key][name]);
      const base = choices.find((c) => c.isDefault) ?? choices[0];
      const tools = choices.map((c) => perKey[c.key][name]);
      const schemas = tools.map(
        (t) => asSchema(t.inputSchema).jsonSchema as any
      );
      // The selector is named for what ChatGPT injects rather than for what it
      // means, because the name's only job is to not be one a server would
      // choose. "account" is an argument a mail or billing server plausibly
      // owns — the lab's create_filter does — and every collision costs this
      // tool its merge. The guard stays whatever the name: a server that does
      // own link_id still gets variants instead of a silently clobbered field.
      const canMerge = schemas.every(
        (s) =>
          s?.type === "object" &&
          !Object.hasOwn(s.properties ?? {}, "link_id") &&
          canonical(s) === canonical(schemas[0])
      );
      if (!canMerge) {
        for (const connection of choices) {
          // 40 + "__" + 20 stays inside the 64-character tool-name limit while
          // keeping the tool name legible: truncating IT collapses two distinct
          // tools that share a prefix into indistinguishable variants.
          let variant = `${name.slice(0, 40)}__${slugById.get(
            connection.connectionId
          )}`;
          const root = variant;
          let n = 2;
          while (reserved.has(variant) || Object.hasOwn(output, variant))
            variant = `${root.slice(0, 60)}-${n++}`;
          reserved.add(variant);
          const tool = perKey[connection.key][name];
          output[variant] = {
            ...tool,
            // A variant has no injected parameter to hang descriptors on —
            // each one IS an account — so identity stays prose. It still has
            // to carry more than the flattened label, or the same profile
            // fields go missing here that went missing on the merged path.
            description: `Account: ${accountPrefix(connection)}. ${
              tool.description ?? ""
            }`,
            execute: tool.execute
              ? (input, opts) => {
                  options.onRoute?.(opts.toolCallId, connection);
                  return tool.execute!(input, opts);
                }
              : undefined,
            _serverId: serverId,
            _mcpToolName: name,
            _connectionId: connection.connectionId,
            _connectionForInput: () => connection,
            _connectionForCall: () => connection,
          } as Tool & ConnectionToolMetadata;
        }
        continue;
      }
      const selected = new Map<
        string,
        { tool: Tool; connection: McpToolConnection; input: unknown }
      >();
      const baseTool = perKey[base.key][name];
      output[name] = {
        // The server's own description rides through untouched. The account
        // list used to be appended to it, on every merged tool, while the enum
        // carried bare ids. It moved onto the property below because that is
        // where the choice is made, and because the tool description was the
        // wrong object for it: truncate it and the model is left an enum of
        // opaque ids with nothing to choose on, failing as a silent
        // wrong-account call rather than as an error.
        ...baseTool,
        inputSchema: jsonSchema({
          ...schemas[0],
          properties: {
            ...schemas[0].properties,
            link_id: {
              type: "string",
              // Kept a bare enum of ids deliberately. Per-value titles via
              // `oneOf`/`const` would read better, but the enum is the shape
              // every provider handles without surprise, and the descriptors
              // below already carry the labels it would encode.
              enum: choices.map((c) => c.connectionId),
              description: `${SELECTOR_GUIDANCE}\n\n${JSON.stringify(
                accountDescriptors(choices),
                null,
                2
              )}`,
            },
          },
          required: [...(schemas[0].required ?? []), "link_id"],
        }),
        execute: async (input: any, opts) => {
          const connection = choices.find(
            (c) =>
              c.connectionId === input?.link_id &&
              options.snapshot.get(c.connectionId) === c.key
          );
          if (!connection) return invalidAccount();
          const { link_id: _linkId, ...args } = input;
          const tool = perKey[connection.key][name];
          selected.set(opts.toolCallId, { tool, connection, input: args });
          options.onRoute?.(opts.toolCallId, connection);
          if (!tool.execute) return invalidAccount();
          return tool.execute(args, opts);
        },
        toModelOutput: async (opts) => {
          const route = selected.get(opts.toolCallId);
          if (!route)
            return {
              type: "text",
              value: "The selected account is unavailable for this tool.",
            };
          return route.tool.toModelOutput
            ? route.tool.toModelOutput({ ...opts, input: route.input })
            : { type: "json", value: opts.output as any };
        },
        _connectionForInput: (input: any) =>
          choices.find((c) => c.connectionId === input?.link_id),
        _connectionForCall: (id: string) => selected.get(id)?.connection,
        _serverId: serverId,
        _mcpToolName: name,
        _connectionIds: choices.map((c) => c.connectionId),
      } as Tool & ConnectionToolMetadata;
    }
  }
  return output;
}
