> ## Documentation Index
> Fetch the complete documentation index at: https://docs.mcpjam.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Pay for one local eval iteration

> Collect the declared prompt fee and reserve one iteration atomically before execution. Retries with the same identity reuse the receipt; changed requests conflict. Uploads claim the payment without charging again.



## OpenAPI

````yaml /reference/openapi.json post /projects/{projectId}/eval-ingest/pay-iteration
openapi: 3.1.0
info:
  title: MCPJam API
  version: 1.0.0-preview
  description: >-
    Programmatic access to MCP servers saved in your MCPJam projects — live
    diagnostics (validate, inspect, export) and operations: call tools, render
    prompts, run eval suites asynchronously and poll their results, and import
    OAuth tokens.


    **The API is in preview**: the surface may change while we finish the
    design. Error `code` values are stable; error `message` strings are not.
    Write clients that ignore unknown response fields.
  contact:
    name: MCPJam
    url: https://github.com/MCPJam/inspector/issues
servers:
  - url: https://app.mcpjam.com/api/v1
    description: Hosted MCPJam
security:
  - bearerAuth: []
tags:
  - name: Agent browsers
    description: >-
      Isolated cloud browser sessions for coding agents. Requires authenticated
      project membership and a configured desktop runtime.
  - name: Clients
    description: >-
      Clients — the named, reusable configurations that define how MCPJam
      connects to and talks to your MCP servers. The original `/hosts` paths
      remain as deprecated, ID-only compatibility aliases with their original
      DTOs and their original (tokenless) write contracts; every alias response
      carries `Deprecation: true`. New integrations should use `/clients`.
  - name: Environments
    description: >-
      Project environments: named, live-editable execution bundles (one host, an
      optional standalone server group, optionally pinned skills and plugin
      versions) that eval suites and goals run against. Distinct from Sandbox
      images, which are Computer base images. Reads require project membership;
      every write requires project admin.
  - name: Plugins
    description: >-
      Agent Plugins imported into a project — read-only inventory and version
      detail.
  - name: Skills
    description: >-
      Cloud Skills: authored SKILL.md files stored in a project. Read-only here.
      Environments pin skills by id (`skillSelection.skillIds`) and eval runs
      pin them with `--compose-skill`, so this surface exists to give an
      unattended caller those ids; authoring is an app flow behind a beta gate.
  - name: Sandbox images
    description: >-
      Custom Computer images: a digest-pinned Dockerfile built into an immutable
      image your project's computers boot from.
  - name: Server diagnostics
    description: Connect-level health checks against a saved MCP server.
  - name: Primitives
    description: 'The server''s MCP primitives: tools, prompts, and resources.'
  - name: Export
    description: Full-server snapshots for diffing and CI.
  - name: Execution
    description: 'Run the server''s primitives: call tools, render prompts.'
  - name: Eval runs
    description: >-
      Asynchronous eval suite runs: create with 202, poll status, iterations,
      and traces.
  - name: Conformance runs
    description: >-
      Ingest MCP spec-conformance results from the SDK/CLI into project-owned
      history. Distinct from Eval runs (authored LLM cases) and from directory
      readiness.
  - name: Server connections
    description: >-
      Connect an MCP server URL to a project, authorizing in a browser when the
      server requires it.
  - name: Server accounts
    description: >-
      The accounts a saved server signs in with, addressed by id or by name.
      Tokens are write-only: an upload takes them and no route returns one.
  - name: OAuth
    description: 'Bring-your-own OAuth: import externally obtained tokens for a server.'
  - name: Studies
    description: >-
      Publish a project environment as a **study** for people outside the
      project to talk to, read what they did, and control who can reach it.
      Several of these NARROW access and take effect immediately.


      The pre-rename paths — `/projects/{projectId}/scenarios`,
      `/projects/{projectId}/scenarios/{scenarioId}`,
      `/projects/{projectId}/environments/{environmentId}/scenario` and
      `/projects/{projectId}/user-testing/scenarios/{scenarioId}/…` — keep
      working and are deliberately not documented here. They return their
      original bodies, which spell the owning id `scenarioId` and whose detail
      read carries no execution settings, and every response answers with
      `Deprecation: true` and a `Link` header naming its successor. They are
      removed at general availability; a new integration should use the paths on
      this page.
  - name: Catalog
    description: >-
      Discover the resources the other routes operate on: your account,
      projects, servers, eval suites, and chat sessions.
  - name: Tunnels
    description: >-
      Relay tunnels that expose local MCP servers through a public URL,
      registered as first-class project servers (the `mcpjam cloud tunnel` CLI
      flow).
  - name: Agent
    description: >-
      Headless agent turns over the public API: send a message history, the
      server runs one assistant turn with project-scoped workspace tools (eval
      reads + suite creation) on a pinned hosted model, and returns the reply
      plus created-resource references.
  - name: Swarms
    description: >-
      Personas, journeys and swarm containers — the authoring half of Swarms —
      plus the model-backed generation that drafts them.
  - name: Swarm runs
    description: >-
      Launching journeys and reading what they produced. Launching SPENDS — see
      the per-operation notes.
  - name: Swarm insights
    description: >-
      What a swarm run revealed. The scorecard and findings are deterministic
      and free; requesting wave insights runs models and draws on your shared
      daily ledger.
  - name: Directory readiness
    description: >-
      Grade a saved server against a publisher's listing requirements:
      Anthropic's connector directory or OpenAI's plugin directory. Reported as
      lane status and coverage, never as a numeric score, and excluded from
      `pooledConformanceScore`. Deterministic grading is free; model-backed
      experience observations are an explicit opt-in whose model cost is on
      MCPJam — no credits are consumed — and they can never decide a verdict.
  - name: Registry
    description: >-
      Search the scraped MCP directories (Claude, ChatGPT, and any future
      source), list curated/org registry cards, and install them into a project.
      Install writes a `servers` row and provenance — it does not open a live
      session. There is no catalog-uninstall route: delete the project server
      instead. Directory reads require a bearer (including minted guest tokens)
      but do not materialize a user. Card/connection reads and all writes are
      authed-non-guest.
  - name: Feedback
    description: >-
      Feedback about MCPJam itself (bugs, missing capabilities, confusing
      behavior), sent to the MCPJam team and kept for 180 days. The
      `send_feedback` MCP tool calls the same endpoint.
paths:
  /projects/{projectId}/eval-ingest/pay-iteration:
    post:
      tags:
        - Eval runs
      summary: Pay for one local eval iteration
      description: >-
        Collect the declared prompt fee and reserve one iteration atomically
        before execution. Retries with the same identity reuse the receipt;
        changed requests conflict. Uploads claim the payment without charging
        again.
      operationId: payEvalIteration
      parameters:
        - name: projectId
          in: path
          required: true
          schema:
            type: string
          description: >-
            Project id, or default to resolve the authenticated organization's
            Default project.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required:
                - runStartId
                - iterationKey
                - caseId
                - billableSteps
              properties:
                runStartId:
                  type: string
                  format: uuid
                iterationKey:
                  type: string
                  format: uuid
                caseId:
                  type: string
                  pattern: ^[A-Za-z0-9_-]{1,128}$
                billableSteps:
                  type: integer
                  minimum: 1
                  maximum: 9007199254740991
      responses:
        '200':
          description: >-
            Iteration payment receipt with paymentId, runStartId, iterationKey
            and billableSteps.
        '400':
          description: Invalid request.
        '401':
          description: Authentication required.
        '403':
          description: Access or payment refused.
        '404':
          description: Owned run start not found.
        '409':
          description: Conflicting iteration payment.
        '413':
          description: Request exceeds 8 KiB.
        '429':
          description: Organization limit reached.
        '503':
          description: Billing unavailable.
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: Bearer [REDACTED]: >-
        MCPJam API key (`sk_…`). Create one at [Settings → API
        keys](https://app.mcpjam.com/settings/api-keys). Guest sessions cannot
        use the API, and API keys cannot manage other API keys.

````

This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.