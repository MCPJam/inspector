# Agent Plugins 1.0 conformance — `@mcpjam/sdk/plugin-bundle`

Status of this parser against the client-implementers checklist at
[agent-plugins.org/client-implementers/conformance](https://agent-plugins.org/client-implementers/conformance)
and the [specification](https://agent-plugins.org/specification).

The load/parse-time requirements are asserted one-test-per-MUST in
[`tests/plugin-bundle/conformance.test.ts`](../../tests/plugin-bundle/conformance.test.ts),
whose `describe` blocks mirror the checklist's sections (Plugin Loader,
Discovery and Isolation, MCP Support, Versioning). This file records what
that suite cannot: where MCPJam departs from the letter of the spec, which
runtime MUSTs are met (and where), and which are not met yet.

## Profiles

`parsePluginBundle` has two profiles. Only `strict`, the default, is the
Agent Plugins 1.0 reader this document grades.

`openai-compatible` is a client-owned dialect adapter for the packaging
OpenAI documents for Codex plugins (`layout.ts`, `legacy-mcp.ts`,
`openai-auth.ts`): `.codex-plugin/` overlays and legacy manifest locations,
legacy `.mcp.json` entries, an entry-level `extensions["com.openai"].auth`
object, and OpenAI's keyed `.app.json`. It reads input the spec does not
define (legacy locations) or forbids (entry `extensions`), so it is not
Agent Plugins conformance and makes no claim to be. A root `plugin.json`
and root `mcp.json` are read by the strict rules under both profiles.

## Deviations that are stricter than the spec

These reject or drop input the spec would accept.

1. **Secret screening of literal values.** The spec passes configured `env`
   and `headers` values through to the runtime verbatim. MCPJam never
   persists a secret-looking literal (bearer/PEM/key-prefix/basic-auth/long
   opaque runs — `SECRET_LIKE_VALUE` in `validation.ts`) in `env` values,
   `headers` values, oauth metadata, or `extensions` namespaces at any depth.
   A dropped literal becomes a required name-only setup requirement
   (`MCP_ENV_VALUE_OMITTED` / `MCP_HEADER_VALUE_OMITTED` /
   `*_SECRET_FIELD_OMITTED`); screened non-secret literals are stored, so
   portable plugins run without a setup step. Parsed bundles land in
   persisted, hashed DTOs, and a credential must never ride into storage.

2. **Extension-namespace values are sanitized, not stored raw.** The spec says
   unimplemented namespaces are ignored without validating their values.
   MCPJam round-trips them through the same recursive secret screen
   (depth-capped at 32, `VALUE_TOO_DEEP`). Fields MCPJam reads with their own
   validation (icon paths, the onboarding skill) are read from the raw value
   and only the validated value is stored.

3. **Symlink/hardlink archive entries are rejected outright**
   (`PATH_LINK_ENTRY`). The spec allows links whose target stays inside the
   root; a parser that never touches a filesystem cannot resolve them.

4. **Escaping archive entry paths are bundle-fatal.** Any absolute, traversing,
   or otherwise unsafe entry path rejects the bundle before any content is
   read. Escapes in configuration (`./` commands, `cwd`) follow the spec's
   narrow boundary and skip only their server entry.

5. **Execution-ambiguous unknown manifest fields are rejected**
   (`MANIFEST_AMBIGUOUS_FIELD`: `scripts`, `command`, `install`, …), rather
   than reported and ignored as other unknown fields are.

6. **Some spec-valid manifest values are rejected.** An unresolved
   `[TODO: …]` placeholder in a kept manifest field (`MANIFEST_PLACEHOLDER`)
   and an empty `version` string are fatal, although the spec checks these
   fields by JSON type only.

7. **Archive and component limits.** Entry, byte, depth, skill and server
   counts (`DEFAULT_PLUGIN_BUNDLE_LIMITS`), Windows/unicode portability rules,
   case-fold collisions, and icon/logo magic-byte checks.

8. **Metadata URLs must be HTTPS to be stored.** A `homepage`, `repository` or
   `author.url` that is malformed or not HTTPS is reported and not stored; the
   plugin still loads, since the spec forbids rejecting a plugin for failing
   a URL check. A non-string value is a schema violation and fatal.

## Deviations that accept more than the spec

These read or tolerate input the spec says to ignore or invalidate, under
the strict profile too.

9. **`oauth` / `authentication` on HTTP entries.** The published entry schema
   is closed, so such an entry is invalid by the letter of the spec. MCPJam
   reads them as its own auth hints (timing, scopes, sanitized metadata).

10. **A top-level `interface` object is read**, for OpenAI's display name and
    icons, instead of being reported and ignored as an unknown field.

11. **Unknown `author` fields are reported and ignored** (`MANIFEST_UNKNOWN_FIELD`)
    rather than invalidating the manifest. A non-string `author.name` or
    `author.email` is fatal, as the spec requires.

12. **`${VAR}` in a header or env value is a setup requirement.** The spec
    expands nothing in header values; MCPJam treats a whole-value `${VAR}` as
    the name of a value the user supplies at setup, and never sends the
    literal text.

## Spec rules MCPJam follows that earlier revisions did not

- Remote MCP URLs must be HTTPS unless the host is `localhost` or a loopback
  literal (the whole `127.0.0.0/8` range or `::1`). The spec now states this
  rule, so it is no longer a deviation.
- A remote URL carrying userinfo or a fragment, even an empty one, or a
  whitespace, backslash or control character (which `URL` would silently
  rewrite), invalidates its entry, and the URL is neither stored nor repeated
  in any issue.
- Header names that differ only in case invalidate their entry
  (`MCP_INVALID_HEADERS`).
- A placeholder-rooted `cwd` (`${PLUGIN_ROOT}/…`, `${PLUGIN_DATA}/…`) is
  normalized under its placeholder, and one that escapes it invalidates the
  entry (`PATH_ESCAPES_ROOT`).
- An invalid `*.app.json` (MCPJam's extension) skips only its own apps.

## Runtime requirements and where they are met

These MUSTs cannot be asserted by a pure parser. The inspector's local
plugin runtime is `mcpjam-inspector/server/services/plugins/`, tested under
its `__tests__/`.

- **Placeholder expansion at launch.** `${PLUGIN_ROOT}`/`${PLUGIN_DATA}`
  substitute only in `args`, `env` values and `cwd`, in a single pass at
  spawn time (`plugin-root.ts`); a leftover placeholder refuses the spawn.
- **Client-controlled variables cannot be shadowed.** The parser rejects any
  bundle whose `env` declares `PLUGIN_ROOT` or `PLUGIN_DATA`
  (`MCP_RESERVED_ENV_KEY`). `resolvePluginStdioLaunch` also writes the bundle's
  own `env` first and the client's `PLUGIN_ROOT`/`PLUGIN_DATA` last.
- **Every plugin stdio server goes through plugin preparation, and runs in
  the plugin root unless it declares a `cwd`.** The backend marks the
  component in the authorize result (`pluginComponent`), and
  `materializePluginStdioForConnect` (`local-stdio.ts`) routes on that as well
  as on a placeholder, so the data directory and both variables do not depend
  on whether the entry mentions them. A backend without the flag falls back
  to the placeholder check.
- **Launch checks after placeholders resolve.** `checkPluginLaunch`
  (`launch-guards.ts`) checks the real working directory is the plugin root,
  its data directory or inside one, so a symlink cannot lead out. It also
  identifies a missing runtime or a missing/non-executable bundle command.
  Hosted boxes get the path rule and report their own missing commands.
- **Bare commands resolve through platform executable search** in the local
  stdio materializer (`local-stdio.ts`).
- **`PLUGIN_DATA` is created before launch and preserved across plugin
  updates** for components that reach the plugin launch path
  (`plugin-data.ts`). On an ephemeral hosted box it lives only as long as the
  box; a persistent Computer keeps it.
- **Materialized-bundle containment** in `bundle-cache.ts` and the node file
  sources.
- **Executable bits survive extraction.** The local cache writes a file the
  archive marks executable as 0755 and every other file as at most 0644 (the
  umask can narrow it), never a special bit (`bundle-cache.ts`). A filesystem
  that stores no modes keeps no bit, which is logged. A hosted box gets the
  same bits after the upload (`computer-stdio.ts`). A browser folder selection carries no
  modes, so a folder import runs its executables through an interpreter; a
  ZIP keeps them.

- **Playground chat isolates a failing plugin server.** `chat-v2.ts` passes
  only the turn's plugin server IDs to `createAuthorizedManager` through
  `tolerateServerRefusals`; `plugin-server-isolation.ts` leaves failed plugin
  components out of the turn. Scenario and harness turns remain strict, as
  do eval, swarm and journey runs that re-check pinned server snapshots.

## Known gaps

- **A cache hit is not checked against a pinned execution digest.** The
  backend pins a version's `bundleHash` but not yet its `executionDigest`, so
  a reused cache entry is verified by content only. Each entry belongs to one
  immutable version, and entries laid out before executables kept their bit
  are never reused.

- **Non-secret configured headers can follow a cross-origin redirect.**
  Stored credential headers are attached only to the origins the backend
  bound them to, hop by hop (`server/utils/credential-header-binding.ts`).
  A plugin's screened non-secret literal headers (`X-Api-Version: 2`) are
  not bound that way.

- **`${PLUGIN_ROOT}` is not permission-enforced read-only.** Components run
  under the same OS account as the cache, so a component can modify its own
  content-addressed entry. Containment and content addressing are enforced;
  immutability is not.

## Out of scope (per the spec's portable vs client-owned split)

Installation sources, enablement/update/cache UX, permission and trust
prompts, sandboxing, and skill presentation are client-owned and not
conformance-bearing. MCPJam's choices there live in the inspector and
backend, not in this package.
