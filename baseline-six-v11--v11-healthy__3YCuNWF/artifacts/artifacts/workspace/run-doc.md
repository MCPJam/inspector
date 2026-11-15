> ## Documentation Index
> Fetch the complete documentation index at: https://docs.mcpjam.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Create an eval run (async)

> Creates a suite run from an existing `suiteId` (rerun) and/or inline `tests`, then **detaches execution and responds `202` immediately** with the `runId`. Validation and quota errors surface on this request; poll `GET /eval-runs/{runId}` for progress. The run appears live in the hosted UI Runs tab, tagged `source: "api"`.

A bare `suiteId` with no inline tests reruns the suite as configured. Per-organization concurrency is capped (default 2 concurrent runs); exceeding it returns `429` with `details.reason: "CONCURRENT_RUN_LIMIT"`.

For a suite with attached project environments, pass `environmentId` to choose which one the run uses; the `202` echoes the resolved `environment` triple, and `GET /eval-runs/{runId}` reports the same triple for the life of the run.

To make the run readable as something more specific than `API` in the Runs table, send `x-mcpjam-launcher` (and `x-mcpjam-ci` from a CI job). Both are labels: `source` is stamped `api` either way.



## OpenAPI

````yaml /reference/openapi.json post /projects/{projectId}/eval-runs
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
  /projects/{projectId}/eval-runs:
    post:
      tags:
        - Eval runs
      summary: Create an eval run (async)
      description: >-
        Creates a suite run from an existing `suiteId` (rerun) and/or inline
        `tests`, then **detaches execution and responds `202` immediately** with
        the `runId`. Validation and quota errors surface on this request; poll
        `GET /eval-runs/{runId}` for progress. The run appears live in the
        hosted UI Runs tab, tagged `source: "api"`.


        A bare `suiteId` with no inline tests reruns the suite as configured.
        Per-organization concurrency is capped (default 2 concurrent runs);
        exceeding it returns `429` with `details.reason:
        "CONCURRENT_RUN_LIMIT"`.


        For a suite with attached project environments, pass `environmentId` to
        choose which one the run uses; the `202` echoes the resolved
        `environment` triple, and `GET /eval-runs/{runId}` reports the same
        triple for the life of the run.


        To make the run readable as something more specific than `API` in the
        Runs table, send `x-mcpjam-launcher` (and `x-mcpjam-ci` from a CI job).
        Both are labels: `source` is stamped `api` either way.
      operationId: createEvalRun
      parameters:
        - $ref: '#/components/parameters/evalVocabularyHeader'
        - $ref: '#/components/parameters/projectId'
        - $ref: '#/components/parameters/launcherHeader'
        - $ref: '#/components/parameters/ciHeader'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EvalRunCreateRequest'
            example:
              suiteName: smoke
              serverIds:
                - srv_abc123
              tests:
                - title: echo works
                  runs: 1
                  model: anthropic/claude-haiku-4.5
                  provider: anthropic
                  steps:
                    - id: s1
                      kind: prompt
                      prompt: Use the echo tool to say hi
                    - id: s2
                      kind: assert
                      assertion:
                        type: toolCalledWith
                        toolName: echo
                        args:
                          args:
                            text: hi
      responses:
        '202':
          description: Run created; execution continues in the background.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EvalRunCreated'
              example:
                runId: run_abc123
                suiteId: suite_def456
                status: running
                caseUpsert:
                  committed:
                    - name: echo works
                  failed: []
                environment: null
        '400':
          $ref: '#/components/responses/ValidationError'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '429':
          $ref: '#/components/responses/RateLimited'
        '500':
          $ref: '#/components/responses/InternalError'
        '502':
          $ref: '#/components/responses/ServerUnreachable'
        '504':
          $ref: '#/components/responses/Timeout'
components:
  parameters:
    evalVocabularyHeader:
      name: x-mcpjam-eval-vocabulary
      in: header
      required: false
      description: >-
        Which vocabulary this request and its response speak. Absent means `1`,
        which is byte-for-byte today's contract: the same request fields, the
        same refusals, the same response projection. `2` is the canonical
        vocabulary. Any other value is a `400` with `code: "VALIDATION_ERROR"`.


        Today it decides one thing: the spelling of an evaluator's policy
        `role`. Vocabulary 1 accepts and returns `gating`; vocabulary 2 accepts
        both spellings and returns the canonical `required`. Sending `required`
        without the header is a `400`, deliberately — vocabulary 1 is not
        widened to meet vocabulary 2 half way, because a boundary that accepts a
        spelling it does not announce is one two implementations can disagree
        about.


        A response that varies by vocabulary sends `Vary:
        x-mcpjam-eval-vocabulary`.
      schema:
        type: string
        enum:
          - '1'
          - '2'
      example: '2'
    projectId:
      name: projectId
      in: path
      required: true
      description: ID of the hosted project that contains the server.
      schema:
        type: string
    launcherHeader:
      name: x-mcpjam-launcher
      in: header
      required: false
      description: >-
        The launching process's own DECLARED identity, as compact JSON:
        `{"kind":"cli"|"mcp"|"github_action","client":"…","version":"…"}`.
        Stored on the run as `launcher` and used only as a display label —
        `source` stays `api` and the audit trail reads the platform-minted
        `attribution` instead.


        A header rather than a body field so that sending it never breaks
        against an older deployment: both eval-run bodies reject unknown
        properties, while an unknown header is ignored everywhere. For the same
        reason a malformed value, or a `kind` outside the three above, is
        DROPPED rather than rejected — a label must never fail a launch. Max 512
        bytes.
      schema:
        type: string
      example: '{"kind":"github_action","client":"mcpjam-cli","version":"8.2.0"}'
    ciHeader:
      name: x-mcpjam-ci
      in: header
      required: false
      description: >-
        The CI job this run was launched from, as compact JSON. Recognized keys:
        `provider`, `pipelineId` (or `runId`), `jobId` (or `job`), `runUrl`,
        `branch`, `commitSha`. Stored on the run as `ciMetadata`, which is what
        makes a run resolvable by commit for baseline comparison. Unrecognized
        keys are dropped.


        A header for the same compatibility reason as `x-mcpjam-launcher`, and
        dropped rather than rejected when malformed. Max 2048 bytes.
      schema:
        type: string
      example: >-
        {"provider":"github_actions","commitSha":"a1b2c3d","branch":"main","runId":"1234.1","job":"evals"}
  schemas:
    EvalRunCreateRequest:
      type: object
      description: >-
        Two valid shapes: `suiteId` (rerun an existing suite, optionally
        upserting inline `tests` into it) or `suiteName` + `tests` + `serverIds`
        (create a new suite and run it). Inline `tests` alone — without a
        `suiteId` or a `suiteName` — are rejected with `VALIDATION_ERROR`.


        `environmentId` requires `suiteId`: an environment is launchable only
        through a suite that has it attached (`environmentIds`, set via `PATCH
        /eval-suites/{suiteId}`), so an environment run on a not-yet-created
        suite could never be satisfied. `environmentId` and `serverIds` are
        mutually exclusive.
      anyOf:
        - required:
            - suiteId
        - required:
            - suiteName
            - tests
            - serverIds
          properties:
            tests:
              minItems: 1
      properties:
        suiteId:
          type: string
          description: >-
            Existing suite to rerun. A bare `suiteId` with no `tests` reruns the
            suite exactly as configured.
        hosts:
          type: array
          description: >-
            Attachments for a new inline suite only. Each host is a project host
            name or ID; servers optionally selects bound server names or IDs. A
            sole host is selected automatically. Omit for the project default.
            Cannot be combined with suiteId.
          items:
            type: object
            required:
              - host
            properties:
              host:
                type: string
                minLength: 1
              servers:
                type: array
                items:
                  type: string
                  minLength: 1
        suiteName:
          type: string
          description: >-
            Name for a new suite. Required (non-empty) when no `suiteId` is
            given.
        suiteDescription:
          type: string
        tests:
          type: array
          maxItems: 100
          description: Inline test cases to upsert into the suite before running.
          items:
            $ref: '#/components/schemas/EvalTestCase'
        serverIds:
          type: array
          minItems: 1
          description: >-
            Servers (by ID) the run connects to. Required when creating a new
            suite; optional on reruns — when omitted, the run connects the
            suite's saved server selection (the set its snapshot references). A
            rerun of a suite with no saved selection is rejected with
            `VALIDATION_ERROR` (`details.reason: "NO_SAVED_SERVER_SELECTION"`).
            Rejected outright for a suite with attached environments
            (`details.reason: "ENVIRONMENT_SERVERS_NOT_OVERRIDABLE"`): the
            environment supplies a closed set that a server override cannot
            change, so accepting one would connect a different set than the run
            is stamped with.
          items:
            type: string
        serverNames:
          type: array
          description: Optional display names, parallel to `serverIds`.
          items:
            type: string
        suiteRerun:
          type: boolean
          description: >-
            When true, skip per-case upsert and rerun the persisted suite. A
            bare `suiteId` with no `tests` is always treated as a rerun.
        modelApiKeys:
          type: object
          description: >-
            Optional per-provider model API keys (e.g. `{ "anthropic":
            "sk-ant-…" }`). Falls back to your organization's configured
            providers when omitted.
          additionalProperties:
            type: string
        notes:
          type: string
        passCriteria:
          type: object
          description: >-
            The floor a run must clear, as a PERCENT in [0, 100] — 80 means 80%.
            `minimumPassRatePercent` is the canonical spelling (the unit is in
            the name); `minimumPassRate` is the deprecated alias for it. Send
            exactly one. THE NAME DISAMBIGUATES THE UNIT: a value in (0, 1) is
            accepted on `minimumPassRatePercent`, where it unambiguously means a
            sub-1% floor the evaluator can act on, and REJECTED on the bare
            `minimumPassRate`, where `0.8` cannot be told apart from a fraction
            sent by mistake and would silently make the gate unfailable. Neither
            field ever reinterprets a value. A per-case `passThreshold` IS a
            fraction; this suite/run floor is not.
          properties:
            minimumPassRatePercent:
              type: number
              minimum: 0
              maximum: 100
              description: >-
                A percent in [0, 100]. The whole range is usable, sub-1 values
                included — the unit is in the field name, so nothing is
                ambiguous. Note that the GitHub Checks gate rounds the measured
                rate to an integer before comparing (to stay in step with the
                eval UI), so a floor below 0.5 behaves there as if it were 0.5;
                the platform's own verdict compares unrounded.
            minimumPassRate:
              type: number
              minimum: 0
              maximum: 100
              deprecated: true
              description: >-
                Deprecated alias for `minimumPassRatePercent`, same unit. A
                value in (0, 1) is REJECTED here — it reads as a fraction sent
                by mistake — which is what the `not` below expresses. Use
                `minimumPassRatePercent` for a genuine sub-1% floor.
              not:
                exclusiveMinimum: 0
                exclusiveMaximum: 1
          oneOf:
            - required:
                - minimumPassRatePercent
            - required:
                - minimumPassRate
          additionalProperties: false
        iterationOverride:
          type: integer
          minimum: 1
          maximum: 10
          description: Override the per-case `runs` count for this run only.
        environmentId:
          type: string
          description: >-
            Run against one of the suite's attached project environments.
            Requires `suiteId`, and must be a member of that suite's
            `environmentIds` — otherwise `400` with `details.reason:
            "ENVIRONMENT_NOT_ATTACHED"`, raised before any case is authored or
            any server connected.


            Omission is meaningful: a suite with no attached environments runs
            legacy; a suite with exactly ONE attached environment runs against
            it automatically (the response's `environment` says which); a suite
            with several returns `400` with `details.reason:
            "ENVIRONMENT_REQUIRED"`, naming the candidates.


            The environment supplies the closed server set (so `serverIds` is
            not required, and is rejected alongside it), and the run is pinned
            to the revision resolved at launch — if the environment changes in
            between, the run is rejected with `409` rather than executing
            against a different configuration.
        ephemeralEnvironment:
          type: boolean
          description: >-
            When true, `environmentId` may be a project-scoped, non-archived
            environment that is NOT attached to the suite. The launch never
            mutates the suite. Absent / false keeps the membership check. Probe
            `GET /environments/capabilities` (`ephemeralEnvironmentLaunch`)
            before sending — older servers reject the unknown field.
        namedHostId:
          type: string
          description: >-
            Run against ONE host attached to the suite. The platform snapshots
            that host's current config onto the run and derives the run's server
            set from it, so a host launch needs no `serverIds`. Without this, a
            suite with host attachments runs under the suite's own default host
            config — the run executes, but the result is attributed to the wrong
            host.


            To run SEVERAL attached hosts, use `POST /eval-run-groups` rather
            than N calls here: it is the surface that bounds the fan-out and
            meters it as one launch.
        caseIds:
          type: array
          minItems: 1
          description: >-
            Narrow the run to these suite cases. The persisted suite is
            untouched — this filters the run's snapshot only. Every id must
            belong to the suite; none matching returns `404`.
          items:
            type: string
        matchOptionsOverride:
          description: >-
            One-off tool-call match options for this run only, layered over
            suite defaults and per-case overrides. Does NOT mutate the suite or
            its cases.


            Accepts EITHER the public vocabulary (`toolCallOrder:
            any|in-order|exact`, `extraToolCalls`, `arguments`) or the internal
            one (`toolCallOrder: ignore|superset|strict`, `maxExtraToolCalls`,
            `argumentMatching`). The two are disjoint, so a body can only be one
            of them; public bodies are normalized server-side.
          type: object
          properties:
            toolCallOrder:
              type: string
              description: >-
                Public: `any` (order ignored) | `in-order` (expected calls
                appear in order, extras allowed) | `exact` (exact sequence).
                Internal equivalents: `ignore` | `superset` | `strict`.
              enum:
                - any
                - in-order
                - exact
                - ignore
                - superset
                - strict
            extraToolCalls:
              description: >-
                Public form: `"unlimited"`, or a maximum count of unexpected
                extra tool calls.
              oneOf:
                - type: string
                  enum:
                    - unlimited
                - type: integer
                  minimum: 0
            arguments:
              type: string
              description: Public form of argument-comparison strictness.
              enum:
                - ignore
                - partial
                - exact
            maxExtraToolCalls:
              description: 'Internal form of `extraToolCalls`: `null` is unlimited.'
              type:
                - integer
                - 'null'
              minimum: 0
            argumentMatching:
              type: string
              description: Internal form of `arguments`.
              enum:
                - ignore
                - partial
                - exact
        skillsOverride:
          type: string
          enum:
            - exclude
          description: >-
            The "without skills" arm of an A/B comparison: the run pins NO
            skills from any channel and is marked `skillsExcluded`, so the arm
            is labelled rather than merely empty. Scoped to skill DELIVERY — a
            pinned plugin's MCP servers stay connected, because which servers an
            arm connects is the one variable a skills A/B has to hold fixed.
        refreshSnapshot:
          type: boolean
          description: >-
            **PERSISTS A SUITE MUTATION.** Re-derives and stores the suite's
            host-config snapshot from this request's server list, so future runs
            of the suite use it too. Without it a rerun leaves the snapshot
            frozen, which is what stops newly connected servers from silently
            contaminating an existing suite. Single-target launches only — it is
            not accepted on `POST /eval-run-groups`, where last-writer-wins on a
            frozen snapshot is never what a fan-out means.
        runGroupId:
          type: string
          description: >-
            A LABEL that groups sibling run rows for display. It has NO quota or
            launch semantics here: N calls carrying one id are still N
            independent launches, each metered separately. Grouped-launch
            behaviour lives on `POST /eval-run-groups`, which mints the id
            itself. Echoed back on the `202`.
        idempotencyKey:
          type: string
          maxLength: 256
          description: >-
            Write-idempotency key. A repeat call with the same key (same actor
            and suite) returns the EXISTING run instead of creating and billing
            a second one. The `Idempotency-Key` header carries the same value
            and WINS over this field — it is the transport-level channel
            unattended clients control, whereas a body key could be shaped by
            model output.
        sourceHash:
          type: string
          pattern: ^[a-f0-9]{64}$
          description: >-
            SHA-256 hex of the suite-file bytes that launched this run.
            Lowercase, 64 characters. Set by `eval run --file`; a UI or API
            launch that did not come from a file omits it.
        importApprovals:
          type: array
          minItems: 1
          description: >-
            Approve `approximated` imported cases for THIS RUN ONLY. The caller
            supplies a hosted test-case id and a reason and nothing else: the
            approver's identity and the approval time are derived server-side
            and frozen into the run's snapshot, because a caller-supplied
            approver would file one person's approval under another's name and a
            caller-supplied timestamp could be backdated past the edit that
            invalidated the claim. Nothing persists on the case — the next run
            of the same approximation needs a new approval.
          items:
            type: object
            required:
              - testCaseId
              - reason
            additionalProperties: false
            properties:
              testCaseId:
                type: string
                minLength: 1
                description: Hosted test-case id — not the authored/declared case id.
              reason:
                type: string
                minLength: 1
                maxLength: 500
                description: Why this approximation is acceptable for this run.
      additionalProperties: false
    EvalRunCreated:
      type: object
      required:
        - runId
        - suiteId
        - status
        - caseUpsert
      properties:
        runId:
          type: string
        suiteId:
          type: string
        status:
          type: string
          description: >-
            The run's status. `running` on a fresh launch; on a replay (see
            `deduped`), the existing run's own status, which may already be
            terminal.
        deduped:
          type: boolean
          description: >-
            Present and true when this request REPLAYED an existing run instead
            of starting one (an idempotency-key hit, or the short keyless dedupe
            window). A replayed run is not executed again, so no further credits
            are spent; read `status` for what that run actually is. Absent on a
            fresh launch.
        runGroupId:
          type: string
          description: >-
            Echo of the request's `runGroupId`, when one was sent. A LABEL only
            — it groups sibling rows for display and carries no quota or launch
            semantics.
        servers:
          type: array
          description: >-
            The servers the run connects to — explicit or derived from the
            suite's saved selection. `name` is present when known (always, on
            the derived path).
          items:
            type: object
            required:
              - id
            properties:
              id:
                type: string
              name:
                type: string
        caseUpsert:
          type: object
          description: >-
            Per-case upsert outcomes for inline `tests`. Partial failures don't
            abort the run.
          properties:
            committed:
              type: array
              items:
                type: object
                properties:
                  id:
                    type: string
                  name:
                    type: string
            failed:
              type: array
              items:
                type: object
                properties:
                  id:
                    type: string
                  name:
                    type: string
                  error:
                    type: string
        environment:
          description: >-
            The environment revision this run is pinned to. `null` on a legacy
            run that recorded none — always present, so a caller never has to
            distinguish absent from unpinned.
          oneOf:
            - $ref: '#/components/schemas/EvalRunEnvironment'
            - type: 'null'
    EvalTestCase:
      type: object
      description: >-
        Inline eval test case. The case body is an ordered `steps` array (the
        unified test model). Exactly one of `runs` / `iterations` is required —
        an inline test on a run has no suite default to inherit. The object is
        CLOSED: an unknown key is a VALIDATION_ERROR, never a silently dropped
        field. `repetitions`, `passThreshold` and `kind` are per-case policy
        fields this surface cannot author — set them through `POST
        /v1/projects/{projectId}/eval-suites/{suiteId}/cases`.
      required:
        - title
        - model
        - provider
        - steps
      oneOf:
        - required:
            - runs
        - required:
            - iterations
      allOf:
        - not:
            required:
              - isNegative
              - isNegativeTest
        - not:
            required:
              - checks
              - predicates
      properties:
        title:
          type: string
        steps:
          type: array
          minItems: 1
          description: >-
            Ordered test steps. The first `prompt` step is the case query;
            `toolCalledWith` asserts are the expected tool calls; a single
            model-free `toolCall` step is a render-check.
          items:
            $ref: '#/components/schemas/EvalTestStep'
        runs:
          type: integer
          minimum: 1
          maximum: 10
          description: Iterations to execute for this case.
        model:
          type: string
          description: >-
            Model ID. Hosted-catalog ids use `provider/name` form (e.g.
            `anthropic/claude-haiku-4.5`) and run on org credits;
            provider-native ids require a matching `modelApiKeys` entry (BYOK).
            Unknown models are rejected with VALIDATION_ERROR at create time.
        provider:
          type: string
          description: Model provider, e.g. `anthropic`, `openai`.
        isNegativeTest:
          type: boolean
          description: When `true`, the case passes if NO tools are called.
        expectedOutput:
          type: string
        advancedConfig:
          type: object
          description: >-
            Optional `system`, `temperature`, `toolChoice` overrides.
            `reasoningEffort` is NOT accepted (`400`): nothing ever applied it.
            Save an effort as `models[].selection.settings.reasoningEffort`
            instead.
          additionalProperties: true
        scenario:
          type: string
        intent:
          type: string
          minLength: 1
          maxLength: 64
          description: Optional authored analytics grouping label.
        matchOptions:
          type: object
          description: >-
            Per-case tool-call matching override, in either vocabulary: public
            (`toolCallOrder: any|in-order|exact`, `extraToolCalls`, `arguments`)
            or internal (`toolCallOrder: ignore|superset|strict`,
            `maxExtraToolCalls`, `argumentMatching`), never both in one object.
          additionalProperties: true
        predicates:
          type: object
          deprecated: true
          description: >-
            DEPRECATED spelling of `checks`, which means exactly this. It was
            accepted here all along and never written down, passing only because
            this schema allowed unknown properties; documented rather than
            removed so no caller already sending it breaks. Send one or the
            other, never both.
          properties:
            mode:
              type: string
              enum:
                - inherit
                - replace
                - extend
            list:
              type: array
              items:
                type: object
        isNegative:
          type: boolean
          description: >-
            Alias for `isNegativeTest` — the public case-authoring spelling this
            API returns on a read. Send one or the other, never both.
        iterations:
          type: integer
          minimum: 1
          maximum: 10
          description: Alias for `runs`. Send one or the other, never both.
        checks:
          type: object
          description: >-
            Per-case CHECK gate — the grading rules this case is scored against.
            `mode` says how they combine with the suite's own: `inherit` uses
            the suite's, `replace` uses only `list`, `extend` appends `list` to
            the suite's. Same field, same shape and same name as `checks` on the
            eval-case routes, so authoring a suite and then editing one of its
            cases is one word for one concept. Send this or the deprecated
            `predicates`, never both.
          properties:
            mode:
              type: string
              enum:
                - inherit
                - replace
                - extend
            list:
              type: array
              items:
                $ref: '#/components/schemas/EvalAssertion'
        suppressedSuiteStandardCheckIds:
          $ref: '#/components/schemas/SuppressedSuiteStandardCheckIds'
          type: array
          items:
            type: string
      additionalProperties: false
    EvalRunEnvironment:
      type:
        - object
        - 'null'
      description: >-
        The project environment a run is pinned to, at the revision resolved
        when it launched. `null` for a legacy run that used the suite's saved
        server selection.
      required:
        - id
      properties:
        id:
          type: string
        name:
          type:
            - string
            - 'null'
        revision:
          type:
            - integer
            - 'null'
          description: The environment revision the run executed against.
    Error:
      type: object
      required:
        - code
        - message
      properties:
        code:
          type: string
          description: >-
            Stable, machine-readable error code. New codes may be added over
            time; treat unknown codes as non-retryable failures unless the HTTP
            status says otherwise.
          enum:
            - UNAUTHORIZED
            - FORBIDDEN
            - NOT_FOUND
            - CONFLICT
            - VALIDATION_ERROR
            - RATE_LIMITED
            - FEATURE_NOT_SUPPORTED
            - SERVER_UNREACHABLE
            - TIMEOUT
            - OAUTH_REQUIRED
            - AUTH_REQUIRED
            - INTERNAL_ERROR
        message:
          type: string
          description: >-
            Human-readable description. May change between releases — don't
            match on it.
        details:
          type: object
          description: Optional, unstructured context bag.
          additionalProperties: true
    EvalTestStep:
      type: object
      description: >-
        One authored test step (the unified test model). `kind` discriminates:
        `prompt` is a user message (model turn); `toolCall` is a deterministic,
        model-free tool call; `interact` is one pure widget action; `assert` is
        an assertion (a `Predicate` like `toolCalledWith` / `widgetRendered`, or
        a DOM `WidgetAssertion`).
      required:
        - id
        - kind
      properties:
        id:
          type: string
          minLength: 1
        kind:
          type: string
          enum:
            - prompt
            - toolCall
            - interact
            - assert
        prompt:
          type: string
          description: 'User message (`kind: prompt`).'
        serverName:
          type: string
          description: 'Server that owns the tool (`kind: toolCall`).'
        toolName:
          type: string
          description: 'Tool name (`kind: toolCall` / `interact`).'
        arguments:
          type: object
          description: 'Tool-call arguments (`kind: toolCall`).'
          additionalProperties: true
        action:
          type: object
          description: 'Widget action (`kind: interact`).'
          additionalProperties: true
        assertion:
          type: object
          description: >-
            The rule an `assert` step checks (`kind: assert`). NOT a narrower
            spelling of a case's `checks`: this is `WidgetAssertion |
            Predicate`, and that union is why the field is called an assertion
            rather than a check. A `Predicate` is evaluated against the
            PERSISTED transcript, so a stored run can be re-graded against it
            months later; a `WidgetAssertion` is evaluated against a LIVE DOM
            and can never be replayed. Calling this a check would promise the
            replayability only one half of it has.
          additionalProperties: true
      additionalProperties: true
    EvalAssertion:
      oneOf:
        - type: object
          properties:
            type:
              type: string
              const: toolDescriptionsPresent
            minLength:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolAnnotationsPresent
            require:
              maxItems: 2
              type: array
              items:
                type: string
                enum:
                  - readOnlyHint
                  - destructiveHint
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolNamesUnique
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: noDeprecatedToolExposed
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolInputSchemasWellFormed
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolOutputSchemasPresent
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolCalledWith
            toolName:
              type: string
              minLength: 1
            args:
              type: object
              properties:
                args:
                  type: object
                  propertyNames:
                    type: string
                  additionalProperties: {}
                argumentMatching:
                  type: string
                  enum:
                    - exact
                    - partial
                    - ignore
              required:
                - args
            minCount:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
            - args
        - type: object
          properties:
            type:
              type: string
              const: toolCalledAtLeastOnce
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
        - type: object
          properties:
            type:
              type: string
              const: toolNeverCalled
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
        - type: object
          properties:
            type:
              type: string
              const: onlyToolsCalled
            toolNames:
              type: array
              items:
                type: string
                minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolNames
        - type: object
          properties:
            type:
              type: string
              const: firstToolWas
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
        - type: object
          properties:
            type:
              type: string
              const: responseContains
            needle:
              type: string
              minLength: 1
            caseSensitive:
              type: boolean
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - needle
        - type: object
          properties:
            type:
              type: string
              const: responseMatches
            pattern:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - pattern
        - type: object
          properties:
            type:
              type: string
              const: noToolErrors
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: finalAssistantMessageNonEmpty
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: tokenBudgetUnder
            tokens:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - tokens
        - type: object
          properties:
            type:
              type: string
              const: widgetRendered
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: widgetRenderLatencyUnder
            ms:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - ms
        - type: object
          properties:
            type:
              type: string
              const: widgetNoConsoleErrors
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: turnCountUnder
            turns:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - turns
        - type: object
          properties:
            type:
              type: string
              const: noEndingQuestion
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolLatencyUnder
            ms:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - ms
        - type: object
          properties:
            type:
              type: string
              const: toolResultContains
            needle:
              type: string
              minLength: 1
              maxLength: 1000
            caseSensitive:
              type: boolean
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - needle
        - type: object
          properties:
            type:
              type: string
              const: toolResultMatchesSchema
            schema: {}
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - schema
        - type: object
          properties:
            type:
              type: string
              const: toolResultSizeUnder
            maxBytes:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - maxBytes
        - type: object
          properties:
            type:
              type: string
              const: argumentsMatchToolSchema
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          description: >-
            A call to toolName whose input matches EVERY pattern (all within one
            call) occurred at least min (default 1) and at most max times. min
            and max count MATCHING calls, not all calls: min 0, max 0 means no
            call matches, not that the tool was never called (use
            toolNeverCalled for that). Patterns are re2js regular expressions
            (no lookaround, no backreferences) matched against the canonical
            JSON of the arguments (sorted keys, no whitespace), or only the
            argument at path when set (a string value as-is, anything else as
            canonical JSON). A call whose subject exceeds 100000 characters is
            unreadable, and a verdict it could decide is unscored.
          properties:
            type:
              type: string
              const: toolInputMatches
            toolName:
              type: string
              minLength: 1
            patterns:
              description: >-
                Every pattern must match the same call. Use alternation (A|B)
                inside one pattern for either.
              minItems: 1
              maxItems: 8
              type: array
              items:
                type: string
                minLength: 1
                maxLength: 512
            flags:
              description: >-
                Applies to every pattern: i (ignore case), m (multiline), s (dot
                matches newline).
              type: string
              enum:
                - i
                - m
                - s
                - im
                - is
                - ms
                - ims
            path:
              description: >-
                JSON Pointer (RFC 6901) to ONE top-level argument key, such as
                /elements; inside the key, ~1 stands for / and ~0 for ~. Omit to
                match the whole arguments object. A call without the key does
                not match.
              type: string
              minLength: 2
              maxLength: 257
              pattern: ^\/(?:[^/~]|~[01])+$
            min:
              description: >-
                Minimum number of MATCHING calls (default 1). min 0 requires
                max.
              type: integer
              minimum: 0
              maximum: 9007199254740991
            max:
              description: >-
                Maximum number of MATCHING calls; at least min (or 1 when min is
                omitted).
              type: integer
              minimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
            - patterns
        - type: object
          description: >-
            A tool result in scope (every result, or only toolName's) whose
            content matches EVERY pattern (all within one result) occurred at
            least min (default 1) and at most max times. min and max count
            MATCHING results, not all results: min 0, max 0 means no result
            matches. The content is the result's text, then structuredContent,
            then its JSON output part (JSON as canonical JSON), or, with path,
            the value at that key in structuredContent (in the JSON output part
            when there is no structuredContent). isError results are included. A
            result whose text was truncated for storage (when path is omitted),
            or whose subject exceeds 100000 characters, is unreadable; so are
            results an incomplete capture did not record. A verdict they could
            decide is unscored.
          properties:
            type:
              type: string
              const: toolResultMatches
            toolName:
              description: Omit to read every tool's results.
              type: string
              minLength: 1
            patterns:
              description: >-
                Every pattern must match the same result. Use alternation (A|B)
                inside one pattern for either.
              minItems: 1
              maxItems: 8
              type: array
              items:
                type: string
                minLength: 1
                maxLength: 512
            flags:
              description: >-
                Applies to every pattern: i (ignore case), m (multiline), s (dot
                matches newline).
              type: string
              enum:
                - i
                - m
                - s
                - im
                - is
                - ms
                - ims
            path:
              description: >-
                JSON Pointer (RFC 6901) to ONE top-level key of
                structuredContent (of the JSON output part when there is no
                structuredContent), such as /elements; inside the key, ~1 stands
                for / and ~0 for ~. Omit to match the whole result. A result
                without the key does not match.
              type: string
              minLength: 2
              maxLength: 257
              pattern: ^\/(?:[^/~]|~[01])+$
            min:
              description: >-
                Minimum number of MATCHING results (default 1). min 0 requires
                max.
              type: integer
              minimum: 0
              maximum: 9007199254740991
            max:
              description: >-
                Maximum number of MATCHING results; at least min (or 1 when min
                is omitted).
              type: integer
              minimum: 0
              maximum: 9007199254740991
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - patterns
        - type: object
          properties:
            type:
              type: string
              const: noRepeatedIdenticalCall
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolCallCountUnder
            count:
              type: integer
              exclusiveMinimum: 0
              maximum: 9007199254740991
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - count
        - type: object
          properties:
            type:
              type: string
              const: toolCalledBefore
            toolName:
              type: string
              minLength: 1
            beforeToolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
            - toolName
            - beforeToolName
        - type: object
          properties:
            type:
              type: string
              const: noDeprecatedToolCalled
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: noDestructiveToolCalled
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: toolErrorNamesInput
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
        - type: object
          properties:
            type:
              type: string
              const: fullPageHasContinuation
            toolName:
              type: string
              minLength: 1
            role:
              type: string
              enum:
                - gating
                - advisory
                - required
            severity:
              type: string
              const: warn
          required:
            - type
      description: >-
        An SDK assertion reported through UVC. Discovery assertions require
        complete raw tool declarations; missing evidence is an evaluator error.
        Observation kinds, including noDeprecatedToolExposed, require role
        advisory. Structural schema; runtime also validates policy and unique
        required annotation keys.
    SuppressedSuiteStandardCheckIds:
      maxItems: 64
      type: array
      items:
        type: string
        enum:
          - discovery.description
          - discovery.annotations
          - discovery.collisions
          - discovery.deprecated
          - call.schema
          - response.schema
          - selection.hops
          - call.parameters
          - call.repeated
          - response.performance
          - response.size
          - response.errors
          - response.recovery
          - response.pagination
          - userValue.turns
      description: >-
        Stable standard assertion family IDs suppressed from suite defaults.
        Applies before inherit/extend/replace resolution; explicit case and step
        assertions are preserved. Omitted updates preserve; [] clears. At most
        64 IDs, normalized to unique sorted values.
  responses:
    ValidationError:
      description: Malformed body or parameters.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: VALIDATION_ERROR
            message: Invalid JSON body
    Unauthorized:
      description: >-
        Missing, invalid, revoked, or orphaned key (`UNAUTHORIZED`) — or the
        **target MCP server** needs an OAuth grant (`OAUTH_REQUIRED`), which is
        a property of the server, not your key.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          examples:
            badKey:
              summary: Invalid or revoked key
              value:
                code: UNAUTHORIZED
                message: Invalid API key
            oauthRequired:
              summary: Target server needs an OAuth grant
              value:
                code: OAUTH_REQUIRED
                message: Server requires OAuth authorization
    Forbidden:
      description: Key is valid but not allowed to do this.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: FORBIDDEN
            message: You do not have access to this project
    NotFound:
      description: Unknown project, server, or resource.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: NOT_FOUND
            message: Server not found
    RateLimited:
      description: >-
        Per-key rate limit exceeded (60 requests/minute sustained, bursts up to
        10). Honor `Retry-After` and back off with jitter.
      headers:
        Retry-After:
          description: Seconds to wait before retrying.
          schema:
            type: integer
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: RATE_LIMITED
            message: API key rate limit exceeded. Slow down and retry.
    InternalError:
      description: Something failed on MCPJam's side.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: INTERNAL_ERROR
            message: Unexpected internal error
    ServerUnreachable:
      description: Could not connect to the target MCP server.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: SERVER_UNREACHABLE
            message: Failed to connect to server
    Timeout:
      description: The target MCP server connected but didn't respond in time.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: TIMEOUT
            message: Request to server timed out
  securitySchemes:
    bearerAuth:
      type: http
      scheme: Bearer [REDACTED]: >-
        MCPJam API key (`sk_…`). Create one at [Settings → API
        keys](https://app.mcpjam.com/settings/api-keys). Guest sessions cannot
        use the API, and API keys cannot manage other API keys.

````

This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.