> ## Documentation Index
> Fetch the complete documentation index at: https://docs.mcpjam.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Create an eval suite (author-only, does not run)

> Creates a runnable eval suite — the suite record plus its test cases — and responds `201` **synchronously**, WITHOUT executing anything. Use this to author a suite, then run it later with `POST /eval-runs` (passing the returned `suiteId`).

This is distinct from `POST /eval-runs`, which creates a run and **detaches execution**, responding `202` with a `runId`. There is no concurrency cap here (no run is started).

The body uses an ergonomic authoring shape: a suite-level default `model` (and optional `provider`) applies to every test unless the test overrides it; `provider` is derived from a `provider/model` id when neither is supplied. Each test's case body is an ordered `steps` array (prompt / toolCall / interact / assert).

Guest callers are denied (suite creation is a write).



## OpenAPI

````yaml /reference/openapi.json post /projects/{projectId}/eval-suites
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
  /projects/{projectId}/eval-suites:
    post:
      tags:
        - Eval runs
      summary: Create an eval suite (author-only, does not run)
      description: >-
        Creates a runnable eval suite — the suite record plus its test cases —
        and responds `201` **synchronously**, WITHOUT executing anything. Use
        this to author a suite, then run it later with `POST /eval-runs`
        (passing the returned `suiteId`).


        This is distinct from `POST /eval-runs`, which creates a run and
        **detaches execution**, responding `202` with a `runId`. There is no
        concurrency cap here (no run is started).


        The body uses an ergonomic authoring shape: a suite-level default
        `model` (and optional `provider`) applies to every test unless the test
        overrides it; `provider` is derived from a `provider/model` id when
        neither is supplied. Each test's case body is an ordered `steps` array
        (prompt / toolCall / interact / assert).


        Guest callers are denied (suite creation is a write).
      operationId: createEvalSuite
      parameters:
        - $ref: '#/components/parameters/evalVocabularyHeader'
        - $ref: '#/components/parameters/projectId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EvalSuiteCreateRequest'
            example:
              name: smoke
              serverIds:
                - srv_abc123
              model: anthropic/claude-haiku-4.5
              tests:
                - title: lists files
                  steps:
                    - id: s1
                      kind: prompt
                      prompt: List the files in the project root.
                    - id: s2
                      kind: assert
                      assertion:
                        type: toolCalledWith
                        toolName: list_files
                        args:
                          args: {}
      responses:
        '201':
          description: The suite was created.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EvalSuiteCreated'
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
  schemas:
    EvalSuiteCreateRequest:
      type: object
      description: >-
        Author-only suite-create body. A suite-level default `model` (and
        optional `provider`) applies to every test unless the test overrides it.
      required:
        - name
        - serverIds
        - model
        - tests
      properties:
        name:
          type: string
          minLength: 1
          description: Suite name.
        description:
          type: string
        serverIds:
          type: array
          minItems: 1
          description: Servers (by canonical project ID) the suite's cases run against.
          items:
            type: string
        serverNames:
          type: array
          description: Optional display names, parallel to `serverIds`.
          items:
            type: string
        hosts:
          type: array
          description: >-
            Clients (hosts) to attach the suite to, in attach order. A suite
            with no attached client reports none wherever it is listed, and a
            run has no host to select. Same shape as the PATCH `hosts` field.
          items:
            type: object
            required:
              - host
            properties:
              host:
                type: string
                minLength: 1
                description: Host name or id.
              servers:
                type: array
                items:
                  type: string
                  minLength: 1
                description: >-
                  Server names (as bound in the suite's environment) or
                  project-server ids.
        model:
          type: string
          minLength: 1
          description: >-
            Suite-level default model id (e.g. `anthropic/claude-haiku-4.5`).
            Used for any test that omits `model`.
        provider:
          type: string
          description: >-
            Optional suite-level default provider. When omitted, the provider is
            derived from a `provider/model` id.
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
        tags:
          type: array
          description: Accepted for forward-compat; not persisted today (no-op).
          items:
            type: string
        tests:
          type: array
          minItems: 1
          maxItems: 100
          description: >-
            Test cases to create in the suite. The object is CLOSED: an unknown
            key is a VALIDATION_ERROR, never a silently dropped field.
            `repetitions`, `passThreshold` and `kind` are per-case policy fields
            this surface cannot author — set them through `POST
            /v1/projects/{projectId}/eval-suites/{suiteId}/cases`.
          items:
            type: object
            required:
              - title
              - steps
            allOf:
              - not:
                  required:
                    - runs
                    - iterations
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
                minLength: 1
              steps:
                type: array
                minItems: 1
                description: >-
                  Ordered test steps (the unified test model). The first
                  `prompt` step is the case query; `toolCalledWith` asserts are
                  the expected tool calls; a single model-free `toolCall` step
                  is a render-check.
                items:
                  $ref: '#/components/schemas/EvalTestStep'
              runs:
                type: integer
                minimum: 1
                maximum: 10
                description: Iterations to execute for this case. Defaults to 1.
              model:
                type: string
                description: Per-case model override. Defaults to the suite-level `model`.
              provider:
                type: string
                description: Per-case provider override.
              expectedOutput:
                type: string
              isNegativeTest:
                type: boolean
                description: When `true`, the case passes if NO tools are called.
              scenario:
                type: string
              advancedConfig:
                type: object
                description: >-
                  Optional `system`, `temperature`, `toolChoice` overrides.
                  `reasoningEffort` is NOT accepted (`400`): nothing ever
                  applied it. Save an effort as
                  `models[].selection.settings.reasoningEffort` instead.
                additionalProperties: true
              intent:
                type: string
                minLength: 1
                maxLength: 64
                description: Optional authored analytics grouping label.
              matchOptions:
                type: object
                description: >-
                  Per-case tool-call matching override, in either vocabulary:
                  public (`toolCallOrder: any|in-order|exact`, `extraToolCalls`,
                  `arguments`) or internal (`toolCallOrder:
                  ignore|superset|strict`, `maxExtraToolCalls`,
                  `argumentMatching`), never both in one object.
                additionalProperties: true
              predicates:
                type: object
                deprecated: true
                description: >-
                  DEPRECATED spelling of `checks`, which means exactly this. It
                  was accepted here all along and never written down, passing
                  only because this schema allowed unknown properties;
                  documented rather than removed so no caller already sending it
                  breaks. Send one or the other, never both.
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
                  Alias for `isNegativeTest` — the public case-authoring
                  spelling this API returns on a read. Send one or the other,
                  never both.
              iterations:
                type: integer
                minimum: 1
                maximum: 10
                description: Alias for `runs`. Send one or the other, never both.
              checks:
                type: object
                description: >-
                  Per-case CHECK gate — the grading rules this case is scored
                  against. `mode` says how they combine with the suite's own:
                  `inherit` uses the suite's, `replace` uses only `list`,
                  `extend` appends `list` to the suite's. Same field, same shape
                  and same name as `checks` on the eval-case routes, so
                  authoring a suite and then editing one of its cases is one
                  word for one concept. Send this or the deprecated
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
      additionalProperties: false
    EvalSuiteCreated:
      type: object
      required:
        - suiteId
        - name
        - caseUpsert
      properties:
        suiteId:
          type: string
        name:
          type: string
        servers:
          type: array
          description: The servers attached to the suite. `name` is present when supplied.
          items:
            type: object
            required:
              - id
            properties:
              id:
                type: string
              name:
                type: string
        hosts:
          type: array
          description: >-
            The clients (hosts) attached to the suite at create time. Empty when
            none were named.
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
            Per-case create outcomes. Partial failures don't abort the suite; an
            all-failed new suite is rejected with VALIDATION_ERROR.
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
  securitySchemes:
    bearerAuth:
      type: http
      scheme: Bearer [REDACTED]: >-
        MCPJam API key (`sk_…`). Create one at [Settings → API
        keys](https://app.mcpjam.com/settings/api-keys). Guest sessions cannot
        use the API, and API keys cannot manage other API keys.

````

This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.