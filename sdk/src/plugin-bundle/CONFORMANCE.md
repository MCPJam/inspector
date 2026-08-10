# Agent Plugins 1.0 conformance — `@mcpjam/sdk/plugin-bundle`

Status of this parser against the client-implementers checklist at
[agent-plugins.org/client-implementers/conformance](https://agent-plugins.org/client-implementers/conformance).

The load/parse-time requirements are asserted one-test-per-MUST in
[`tests/plugin-bundle/conformance.test.ts`](../../tests/plugin-bundle/conformance.test.ts),
whose `describe` blocks mirror the checklist's sections (Plugin Loader,
Discovery and Isolation, MCP Support, Versioning). This file records what
that suite cannot: MCPJam's deliberate deviations from the letter of the
spec, and the runtime MUSTs that are satisfied (and tested) outside this
package.

## Documented deviations

Each of these is intentional, spec-visible behavior. All are *stricter* than
the spec or additive policy — none accepts input the spec forbids.

1. **Secret screening of literal values.** The spec passes configured `env`
   and `headers` values through to the runtime verbatim. MCPJam never
   persists a secret-looking literal (bearer/PEM/key-prefix/basic-auth/long
   opaque runs — `SECRET_LIKE_VALUE` in `validation.ts`), in `env` values,
   `headers` values, oauth metadata, or `extensions` namespaces at any
   depth. A dropped literal becomes a *required* name-only setup
   requirement (`MCP_ENV_VALUE_OMITTED` / `MCP_HEADER_VALUE_OMITTED` /
   `*_SECRET_FIELD_OMITTED` warnings); screened non-secret literals
   (`{"MODE": "production"}`, `X-Api-Version: 2`) are stored so portable
   plugins run without a setup step. Rationale: parsed bundles land in
   persisted, hashed DTOs — a credential must never ride into storage.

2. **Extension-namespace values are sanitized, not stored raw.** The spec
   says unimplemented namespaces are ignored without validating their
   values. MCPJam round-trips them, but through the same recursive secret
   screen (secret-looking keys/values dropped, nesting depth-capped at 32
   with `VALUE_TOO_DEEP`). Non-secret content is preserved byte-for-byte.

3. **Symlink/hardlink archive entries are rejected outright**
   (`PATH_LINK_ENTRY`). The spec's package boundary asks clients to resolve
   links and verify the target stays inside the root; MCPJam refuses link
   entries entirely — strictly stronger, and the only portable answer for a
   parser that never touches a filesystem.

4. **Escaping archive entry paths are bundle-fatal.** The spec's failure
   ladder allows "deny access" per path for some escapes. Any absolute,
   traversing, or otherwise unsafe *entry* path rejects the whole bundle at
   archive validation, before a single byte of content is read. Per-entry
   escapes in *configuration* (`./` commands, `cwd`) do follow the spec's
   narrow boundary: they skip only that server entry.

5. **Execution-ambiguous unknown manifest fields are rejected, not
   report-and-ignored** (`MANIFEST_AMBIGUOUS_FIELD`: `scripts`, `command`,
   `install`, `postinstall`, …). "Ignored" is exactly what an attacker
   shipping an `install_script` field would want; other unknown fields get
   the spec's report-and-ignore treatment.

6. **`oauth` / `authentication` are accepted on http entries.** The
   published entry schema is closed; MCPJam recognizes these two extra
   fields as extension hints (auth timing, scopes, sanitized metadata)
   instead of invalidating the entry.

7. **HTTPS is required for remote URLs.** The spec requires URL validation
   before connecting but does not mandate a scheme. MCPJam rejects
   plain-HTTP remote URLs per entry (`MCP_INSECURE_URL`) and allows
   plain-HTTP loopback with a warning (`MCP_INSECURE_URL_LOCALHOST`).

8. **Alternate transport spellings are rejected on the plugin path.** The
   entry `type` consts are exact (`stdio` | `streamable-http` | `sse`);
   `streamable_http` / `streamableHttp` / `http` invalidate the entry. The
   exported shape primitives (`selectPluginMcpServerMap`,
   `detectPluginMcpTransport`) keep lenient folding for the inspector's
   generic MCP-JSON import — a different consumer with a different policy.

9. **Additive hygiene policy** beyond the schema: archive limits
   (entries/bytes/depth/skill/server counts, `DEFAULT_PLUGIN_BUNDLE_LIMITS`),
   `[TODO: …]` placeholder rejection in kept manifest fields, HTTPS-only
   metadata URLs, icon/logo magic-byte checks, Windows/unicode path
   portability rules, and duplicate/case-collision path rejection.

10. **`${PLUGIN_DATA}` on ephemeral hosted boxes lives for the box
    lifetime.** The spec asks for a data directory "preserved across plugin
    updates". The local runtime satisfies this (`~/.mcpjam/plugin-data`,
    keyed by plugin identity, surviving bundle updates). When plugin
    components run on an ephemeral hosted box, the directory is created
    before launch per spec but persists only as long as the box does.

## Requirements covered elsewhere (runtime)

These MUSTs cannot be asserted by a pure parser. They are implemented and
tested in the inspector's local plugin runtime,
`mcpjam-inspector/server/services/plugins/` (tests under `__tests__/`:
`plugin-root.test.ts`, `local-stdio.test.ts`, `local-stdio.desktop.test.ts`,
`run-plugin-servers.test.ts`, `bundle-cache.test.ts`):

- **Placeholder expansion at launch** — `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
  substitute only in `args`, `env` values, and `cwd`, in a single pass at
  spawn time (`plugin-root.ts`); a leftover placeholder refuses the spawn so
  a child process never sees a literal `${…}` token.
- **Client-controlled variables cannot be shadowed** — satisfied by PARSE-TIME
  rejection, not by ordering. `resolvePluginStdioLaunch` seeds the env with the
  injected `PLUGIN_ROOT`/`PLUGIN_DATA` aliases and then writes the bundle's own
  `env` over them, so an internally constructed launch spec could shadow an
  alias; no imported bundle can, because the parser rejects any bundle whose
  `env` declares the reserved keys. The spec phrases this MUST as "set last" —
  MCPJam meets the guarantee by a different mechanism.
- **Bare commands resolve through platform executable search rules** — the
  local stdio materializer (`local-stdio.ts`).
- **`PLUGIN_DATA` created before launch and preserved across plugin
  updates** — `plugin-data.ts` (see deviation 10 for hosted boxes).
- **Continue loading when one server fails to start/connect/authenticate** —
  per-server failure isolation in `run-plugin-servers.ts`; authentication
  failure is a connection failure, not invalid package configuration.
- **Materialized-bundle boundary enforcement** — extraction and cache
  containment in `bundle-cache.ts` / `bundle-file-sources.ts`.

## Known gaps (runtime MUSTs not yet met)

- **`cwd` does not default to the plugin root.** The spec says an entry that
  omits `cwd` runs with the plugin root as its working directory.
  `resolvePluginStdioLaunch` emits `workingDirectory` only when the entry
  supplied one, and the local resolver forwards `cwd` only when present, so
  the stdio transport inherits the inspector process's working directory
  instead. An entry with a relative entrypoint or relative resource paths and
  no explicit `cwd` will therefore misbehave. Entries that DO declare a `cwd`
  (including `./`-relative ones) are unaffected, as are `${PLUGIN_ROOT}`-
  prefixed commands, which resolve to absolute paths. Fixing this is a
  behavior change to the launch path and is deliberately not bundled into
  this docs-and-tests PR.

## Out of scope (per the spec's portable vs client-owned split)

Installation sources, enablement/update/cache UX, permission and trust
prompts, sandboxing, and skill *presentation* are explicitly client-owned
and not conformance-bearing. MCPJam's choices there live in the inspector
and backend, not in this package.
