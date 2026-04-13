# MCP 2025-11-25 Interpretation

Use this file to calibrate findings against the latest MCP spec and related OAuth standards.

Primary MCP references:

- `https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle`
- `https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization`
- `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/tools`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/resources`
- `https://modelcontextprotocol.io/specification/2025-11-25/schema`

## Claim strength ladder

- `MUST` or `MUST NOT`
  Usually a real conformance issue when the evidence is direct.
- `SHOULD` or `RECOMMENDED`
  Usually an interoperability or hardening warning, not a hard failure.
- `MAY`, optional fields, optional capabilities
  Usually `info` unless the absence causes a concrete break.

## Lifecycle and capability negotiation

- Initialization must be the first interaction.
- Clients and servers should only rely on capabilities that were successfully negotiated.
- For feature families such as tools, resources, and prompts, capability declaration matters. Do not infer support from a convenience default or empty list alone.

## Transport interpretation

- MCP defines `stdio` and Streamable HTTP as the standard transports.
- For Streamable HTTP:
  - the server must expose one endpoint that supports `POST` and `GET`
  - clients send JSON-RPC messages with `POST`
  - `GET` can be used to open an SSE stream
  - the `MCP-Protocol-Version` header matters after initialization
- Transport quirks are only high severity when they create actual breakage or violate a `MUST`. A transport mismatch can still be only an interop issue if clients have a documented fallback path.

## Authorization interpretation

- Authorization is optional at the MCP level overall, but HTTP-based implementations that support auth should follow the authorization spec.
- MCP servers must implement protected-resource metadata discovery. They can do this through either:
  - `WWW-Authenticate` with `resource_metadata`
  - well-known protected-resource metadata
- Missing `resource_metadata` in `WWW-Authenticate` is not automatically a hard failure if the well-known metadata path works.
- `scope` in the `WWW-Authenticate` challenge is guidance and is only a `SHOULD`.
- `scopes_supported` is useful for clients, but absence is not automatically a protocol failure.
- Redirect URI findings need calibration:
  - accepting non-localhost `http://` redirect URIs is a real problem under the MCP profile
  - accepting arbitrary `https://` redirect URIs is not automatically a vulnerability; open registration and trust-policy details matter
  - custom schemes may be allowed by generic OAuth rules even where the MCP profile is stricter
- PKCE findings need calibration:
  - clients must verify PKCE support before proceeding
  - `S256` support is essential for MCP compatibility
  - supporting `plain` in addition to `S256` is usually a hardening note, not by itself a spec violation
- Dynamic client registration findings need calibration:
  - relative or non-functional `registration_client_uri` is a real RFC7592 issue
  - accepting unsupported grant types in DCR is often compatibility drift unless the unsupported flow is actually usable

## Tools interpretation

- Servers that support tools must declare the `tools` capability.
- `outputSchema` is optional. Missing `outputSchema` is `info` unless the surrounding workflow depends on validated structured output.
- Tool or content annotations improve UX but are not mandatory in the way scanners often imply.
- Separate protocol errors from tool execution errors:
  - invalid params, malformed requests, and unknown methods belong to JSON-RPC error handling
  - execution failures often belong in the tool result path
- An internal-looking tool error payload is only notable if it leaks secrets, stack traces, internal topology, or otherwise harmful details. A request ID alone is usually a low-severity debugging detail.

## Resources and prompts interpretation

- Servers that support resources must declare the `resources` capability.
- Servers that support prompts must declare the `prompts` capability.
- Optional `listChanged` and `subscribe` flags should not be escalated when absent.
- `mimeType` and descriptive metadata are useful quality signals, but do not overstate them unless the specific field is required for the response shape being evaluated.
- Unsupported `resources/templates` is often fine; treat it as unsupported or skipped unless the server advertised behavior that conflicts with the response.

## Common overstatements to avoid

- Missing optional metadata is not the same thing as a protocol violation.
- A single negative test does not prove broader security posture.
- A local convenience field is not a server field.
- A passing rejection case does not prove the server validated all related edge cases.
- Root-level and path-aware metadata differences should be evaluated in the context of the exact resource identifier the client is using.

## Default severity calibration

- `high`
  Clear `MUST` violation with real exploitability or a credible break for conforming clients.
- `medium`
  Real standards issue or strong interop problem, but not obviously exploitable.
- `low`
  Minor standards drift, UX issue, or debugging leakage with limited impact.
- `info`
  Optional metadata, polish, implementation style, or observations that are true but not important.

## Default confidence calibration

- `high`
  Direct wire evidence plus clear spec text.
- `medium`
  Strong indicators, but interpretation still depends on omitted context or downstream behavior.
- `low`
  The finding depends on client inference, convenience output, or unverified assumptions.
