> ## Documentation Index
> Fetch the complete documentation index at: https://docs.mcpjam.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Create an eval case

> Adds one case to the suite. Both `title` and a non-empty `steps` array are required — `steps` is optional on the shared case shape so PATCH can be partial, but a case persisted without executable steps could never run. When `models` is omitted the suite's configured model is used.



## OpenAPI

````yaml /reference/openapi.json post /projects/{projectId}/eval-suites/{suiteId}/cases
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
  /projects/{projectId}/eval-suites/{suiteId}/cases:
    post:
      tags:
        - Eval runs
      summary: Create an eval case
      description: >-
        Adds one case to the suite. Both `title` and a non-empty `steps` array
        are required — `steps` is optional on the shared case shape so PATCH can
        be partial, but a case persisted without executable steps could never
        run. When `models` is omitted the suite's configured model is used.
      operationId: createEvalCase
      parameters:
        - $ref: '#/components/parameters/evalVocabularyHeader'
        - $ref: '#/components/parameters/projectId'
        - $ref: '#/components/parameters/suiteId'
        - $ref: '#/components/parameters/declaredSuiteIdQuery'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/EvalCaseCreateRequest'
            example:
              title: lists files
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
          description: The created case.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EvalCase'
        '400':
          $ref: '#/components/responses/ValidationError'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '403':
          $ref: '#/components/responses/Forbidden'
        '404':
          $ref: '#/components/responses/NotFound'
        '409':
          $ref: '#/components/responses/Conflict'
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
    suiteId:
      name: suiteId
      in: path
      required: true
      description: Eval suite ID, as returned by `POST /eval-runs`.
      schema:
        type: string
    declaredSuiteIdQuery:
      name: declaredSuiteId
      in: query
      required: false
      description: >-
        The suite file's own `suite.id`, when this request is that file syncing
        itself. A CI-owned suite (see `EvalSuiteDetail.managedBy`) refuses
        configuration writes with `409` and `details.reason:
        "CI_OWNED_SUITE_READ_ONLY"`; naming the suite's own declared id is how
        the file writing itself is allowed through. Naming any other id refuses
        exactly as loudly as naming none, so it is not a capability — omit it
        for an ordinary edit.


        A QUERY PARAMETER on every route that takes it, never a body field.
        These request bodies are strict, here and on every Inspector that
        predates the CI-owned lock, so a body field is a `400` against an older
        deployment — which would break `mcpjam cloud eval run --file` for anyone
        whose CLI is newer than their Inspector. A query parameter is read by
        the deployments that know it and ignored by those that do not, which is
        the right degradation: an Inspector with no lock has no exception to
        make.
      schema:
        type: string
        maxLength: 128
  schemas:
    EvalCaseCreateRequest:
      type: object
      required:
        - title
        - steps
      description: >-
        Create one case. `title` and a non-empty `steps` array are both required
        — a case persisted without executable steps could never run.
      properties:
        judge:
          type: object
          additionalProperties: false
          properties:
            enabled:
              type: boolean
          nullable: true
          description: >-
            Per-case judge override. enabled: false skips goal-completion
            grading for this case; null clears the override and restores the
            suite setting.
        declaredSuiteId:
          type: string
          maxLength: 128
          description: >-
            The suite file's own `suite.id`, when THIS request is a suite-file
            sync.


            A CI-owned suite (see `EvalSuiteDetail.managedBy`) refuses
            configuration writes with `409` and `details.reason:
            "CI_OWNED_SUITE_READ_ONLY"`. Naming the suite's own declared id is
            how the file writing itself is allowed through — the platform
            permits the write only when the id matches, so naming any other id
            refuses exactly as loudly as naming none. Omit it for ordinary
            edits.


            PREFER THE `declaredSuiteId` QUERY PARAMETER on this route. This
            body field still works here, but these request bodies are strict on
            every Inspector that predates the CI-owned lock, so a body field is
            a `400` against an older deployment while an unknown query parameter
            is simply ignored. The MCPJam SDK and CLI send the query parameter.
        title:
          type: string
          minLength: 1
        id:
          type: string
          pattern: ^[A-Za-z0-9_-]{1,128}$
          description: >-
            Stable declared id for the case — the id it answers to in a suite
            file, an import or a CLI argument. Minted for you when omitted, and
            unique within the suite. Distinct from the `id` on the response,
            which is the case's platform row id.
        steps:
          type: array
          minItems: 1
          items:
            $ref: '#/components/schemas/EvalTestStep'
          description: REPLACES the case's test definition wholesale when provided.
        expectedOutput:
          type: string
        iterations:
          type: integer
          minimum: 1
          maximum: 10
        repetitions:
          type: integer
          minimum: 1
          maximum: 10
          description: >-
            Per-case repetitions; omitted cases inherit the suite default.
            PER-CASE GRADING ONLY — on a suite decided by the suite-wide
            accuracy threshold this is a VALIDATION_ERROR naming the criterion
            change that would make it readable, because that criterion takes the
            trial count from `iterations` raised to the suite's
            `minimumIterations` and would never read this. Capped at 10, the
            same hosted ceiling as `iterations`; the suite-file contract's
            larger `MAX_REPETITIONS` is what a file may DECLARE, not what a
            hosted run accepts.
        passThreshold:
          type: number
          minimum: 0
          maximum: 1
          description: >-
            Per-case pass threshold FRACTION: the share of this case's own
            iterations that must pass. PER-CASE GRADING ONLY — on a suite
            decided by the suite-wide accuracy threshold this is a
            VALIDATION_ERROR, for the same reason as the count: that criterion
            has one percentage over the whole run and no per-case threshold to
            override.
        isNegative:
          type: boolean
        scenario:
          type: string
        intent:
          type: string
          minLength: 1
          maxLength: 64
          pattern: ^\S(?:[\s\S]*\S)?$
          description: Optional authored analytics grouping label. Must be already trimmed.
        kind:
          type: string
          enum:
            - capability
            - regression
          description: >-
            Authored case kind for the simple editor. Absent means the editor
            derives it from matchOptions.
        models:
          type: array
          items:
            type: object
            required:
              - model
            properties:
              model:
                type: string
              provider:
                type: string
                description: Derived from a `provider/model` id when omitted.
              selection:
                allOf:
                  - $ref: '#/components/schemas/RequestedModelSelection'
                description: >-
                  The saved model choice behind `model` (source, connection,
                  `settings.reasoningEffort`). Must be FOR `model`. On a
                  `models` PATCH an entry that omits `selection` KEEPS the
                  case's existing selection for that model; `null` drops it.
        matchOptions:
          type:
            - object
            - 'null'
          description: >-
            Tool-call match options in either vocabulary: public
            (`toolCallOrder: any|in-order|exact`, `extraToolCalls`, `arguments`)
            or internal (`toolCallOrder: ignore|superset|strict`,
            `maxExtraToolCalls`, `argumentMatching`), never both in one object.
            On update, fields you omit keep their current values. `null` clears
            the case override and inherits the suite's.
        checks:
          type:
            - object
            - 'null'
          description: '`null` clears the case override.'
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
        import:
          $ref: '#/components/schemas/EvalCaseImportClaim'
        source:
          $ref: '#/components/schemas/EvalCaseSource'
        suppressedSuiteStandardCheckIds:
          $ref: '#/components/schemas/SuppressedSuiteStandardCheckIds'
          type: array
          items:
            type: string
      additionalProperties: false
    EvalCase:
      type: object
      required:
        - id
        - title
        - steps
        - iterations
        - isNegative
        - models
      description: >-
        A persisted eval case, in the public steps-first shape. Note this is NOT
        `EvalTestCase`, which is the INLINE authoring shape accepted by suite
        creation.
      properties:
        judge:
          type: object
          additionalProperties: false
          properties:
            enabled:
              type: boolean
          description: >-
            Per-case judge override. enabled: false skips goal-completion
            grading for this case.
        id:
          type: string
        declaredId:
          type: string
          description: >-
            The case's effective declared id. Absent on cases authored before
            declared identity existed.
        title:
          type: string
        steps:
          type: array
          minItems: 1
          items:
            $ref: '#/components/schemas/EvalTestStep'
          description: >-
            Ordered test steps. A `prompt` step is a model turn; a single
            model-free `toolCall` step is a render-check; `assert` steps hold
            the expectations.
        expectedOutput:
          type: string
        iterations:
          type: integer
          minimum: 1
          maximum: 10
        repetitions:
          type: integer
          minimum: 1
          description: >-
            Trials this case runs under per-case grading, overriding the suite
            default. Absent means the case inherits it. NOT a second spelling of
            `iterations`: that one is read as a FLOOR (`max(iterations,
            suite.minimumIterations)`) by a suite decided on suite-wide
            accuracy, and a per-case-graded case still reports it for
            compatibility. This one REPLACES the count rather than raising it —
            a case at 7 runs 7 times under a floor of 3 and 3 times under a
            default of 3.
        passThreshold:
          type: number
          minimum: 0
          maximum: 1
          description: >-
            Fraction of this case's trials that must pass, overriding the suite
            default. Absent means the case inherits it. Never derived from the
            suite's `minimumAccuracy`, which is a PERCENT under a different
            resolver.
        isNegative:
          type: boolean
          description: When true, the case passes if NO tools are called.
        scenario:
          type: string
        intent:
          type: string
          minLength: 1
          maxLength: 64
          pattern: ^\S(?:[\s\S]*\S)?$
          description: >-
            Optional authored analytics grouping label. Must be already trimmed;
            absent means unlabelled.
        kind:
          type: string
          enum:
            - capability
            - regression
          description: >-
            Authored case kind for the simple editor. Absent means the editor
            derives it from matchOptions.
        models:
          type: array
          items:
            type: object
            required:
              - model
            properties:
              model:
                type: string
                readOnly: true
                description: >-
                  COMPUTED in responses: the selection's `modelId` when there is
                  one, else the stored bare id. Accepted on writes as a
                  shorthand: send a bare id and the platform converts it (a
                  hosted id becomes a `hosted` selection, any other a
                  `LegacyModelSelection`).
              provider:
                type: string
              selection:
                allOf:
                  - $ref: '#/components/schemas/RequestedModelSelection'
                description: >-
                  The saved model choice behind `model` (source, connection,
                  `settings.reasoningEffort`). Absent when the case stores only
                  a bare model id. May be a STORED legacy selection
                  (`LegacyModelSelection`, `source: "legacy"`): own key only,
                  never MCPJam credits. The model id beside it is computed from
                  it.
              selectionOrigin:
                type: string
                enum:
                  - backfill
                description: >-
                  `backfill` when a conversion (a save of a bare id, or the
                  old-data backfill) chose `selection` rather than a person.
                  Absent when a person chose it, and on rows with no selection.
        matchOptions:
          type: object
          description: >-
            In the public vocabulary (`toolCallOrder: any|in-order|exact`,
            `extraToolCalls`, `arguments`). Absent when the case sets none —
            omitted from the response rather than sent as `null`.
        checks:
          type: object
          description: >-
            Absent when the case sets none — omitted from the response rather
            than sent as `null`.
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
        import:
          $ref: '#/components/schemas/EvalCaseImportClaim'
        source:
          $ref: '#/components/schemas/EvalCaseSource'
        createdAt:
          type:
            - number
            - 'null'
        updatedAt:
          type:
            - number
            - 'null'
        suppressedSuiteStandardCheckIds:
          $ref: '#/components/schemas/SuppressedSuiteStandardCheckIds'
          type: array
          items:
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
    RequestedModelSelection:
      description: >-
        What a store-once row holds as its ONLY copy of the model: a full
        `ModelSelection` (`hosted` runs on MCPJam credits, `org` on an
        organization connection, `local` on a key on the caller's machine) or a
        STORED `LegacyModelSelection` (own key only). Wherever one sits beside a
        model id (`modelId`, `model`), that id is COMPUTED from it on reads, and
        accepted on writes as a shorthand the platform converts. A row with
        neither is an unlabelled old row and runs exactly as it always has.
      oneOf:
        - $ref: '#/components/schemas/ModelSelection'
        - $ref: '#/components/schemas/LegacyModelSelection'
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
    EvalCaseImportClaim:
      type: object
      description: >-
        What a converter CLAIMED about one imported case. `exact` is
        CONVERTER-CLAIMED exact — the converter says it applied a structural
        mapping rule, cited in `note`. MCPJam has NOT verified semantic
        equivalence, so user-facing copy must say "claimed exact", never
        "verified" or "accepted". Claim-only: who approved an approximation,
        when, and why is a PER-RUN decision frozen on the run
        (`ImportEligibility.approvedApproximationReceipts`), never stored on the
        case — an approval that lived on a case would outlive the run it was
        granted for and the edit that invalidated it. Approval and internal keys
        are rejected with 400, never stripped.
      required:
        - status
      additionalProperties: false
      properties:
        status:
          type: string
          enum:
            - exact
            - approximated
            - unsupported
            - unresolved
          description: >-
            `exact`: the converter claims a 1:1 structural mapping, and must
            cite it in `note`. `approximated`: behaviour was intentionally
            approximated; a human must approve it for EVERY run. `unsupported`:
            the source behaviour cannot currently be represented. `unresolved`:
            a deterministic reference does not resolve against the live target.
            A selected `unsupported` or `unresolved` case cannot run.
        sourceCaseKey:
          type: string
          minLength: 1
          maxLength: 512
          description: The case's identity in the source system, when it had one.
        note:
          type: string
          minLength: 1
          maxLength: 2000
          description: >-
            Why the status is what it is — the mapping rule cited, or what was
            lost. REQUIRED when `status` is `exact`.
    EvalCaseSource:
      type: object
      description: >-
        Where an AI-assisted Markdown case was authored from. Provenance only:
        the file, its hash, and the line range the extractor read, so a reader
        can trace a case back to its source document. It is not an import claim
        (see `EvalCaseImportClaim`) and carries no approval semantics.
      required:
        - format
        - method
        - fileName
        - fileHash
        - excerpt
        - startLine
        - endLine
        - extractorVersion
      additionalProperties: false
      properties:
        format:
          type: string
          enum:
            - markdown
        method:
          type: string
          enum:
            - ai
          description: >-
            How the case was derived from the document. `ai`: an extractor model
            proposed it and a person reviewed it before it was saved.
        fileName:
          type: string
          minLength: 1
          maxLength: 255
        fileHash:
          type: string
          pattern: ^[a-f0-9]{64}$
          description: SHA-256 of the source document, lowercase hex.
        excerpt:
          type: string
          minLength: 1
          maxLength: 102400
          description: The passage the case was extracted from.
        startLine:
          type: integer
          minimum: 1
        endLine:
          type: integer
          minimum: 1
          description: Inclusive; never less than `startLine`.
        extractorVersion:
          type: string
          minLength: 1
          maxLength: 100
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
    ModelSelection:
      type: object
      description: >-
        A saved model choice. Never carries a secret: an unknown key is refused.
        `settings.reasoningEffort` is where a reasoning effort is saved — there
        is no other saved carrier (`advancedConfig.reasoningEffort` is refused).
        Which efforts a model accepts is `supportedReasoningEfforts` on `GET
        /v1/models`; a saved effort the route the run takes cannot apply is
        refused (`capability_missing`), never dropped.
      required:
        - modelId
        - source
        - fallback
      additionalProperties: false
      properties:
        modelId:
          type: string
          description: Canonical `provider/model` id.
        source:
          type: string
          enum:
            - hosted
            - org
            - local
          description: Whose credentials pay for and serve the call.
        connectionRef:
          type: object
          description: >-
            Required for `org` (`kind: orgProvider`) and `local` (`kind:
            localProvider`), absent for `hosted`.
          required:
            - kind
          additionalProperties: false
          properties:
            kind:
              type: string
              enum:
                - orgProvider
                - localProvider
            id:
              type: string
              description: The organization model provider row (`orgProvider`).
            providerKey:
              type: string
              description: >-
                The provider configured on the user's own machine
                (`localProvider`).
            customProviderName:
              type: string
        nativeModelId:
          type: string
          description: >-
            Deployment or native id where it is not derivable from `modelId`
            (Azure deployment name, Bedrock inference profile, custom provider).
        settings:
          type: object
          additionalProperties: false
          properties:
            reasoningEffort:
              type: string
              enum:
                - none
                - minimal
                - low
                - medium
                - high
                - xhigh
                - max
              description: >-
                Reasoning effort. An effort replaces the sampling temperature: a
                `temperature` beside it is dropped or refused, depending on the
                route.
            temperature:
              type: number
              minimum: 0
              maximum: 2
        fallback:
          type: object
          required:
            - provider
            - model
          additionalProperties: false
          properties:
            provider:
              type: string
              enum:
                - none
                - openrouter
            model:
              type: string
              enum:
                - none
              description: 'Always `none`: no surface substitutes a different model.'
    LegacyModelSelection:
      type: object
      description: >-
        A STORED legacy selection: a model id with no saved source. Written when
        a save sends a bare id the platform does not host (the shorthand), or by
        the old-data backfill. It means OWN KEY ONLY: the call runs on the
        organization's connection for the model's provider (or a key on the
        caller's machine) and never on MCPJam credits. It carries no settings;
        to save an effort, send a full `ModelSelection`. A read may be sent back
        verbatim.
      required:
        - source
        - modelId
      additionalProperties: false
      properties:
        source:
          type: string
          enum:
            - legacy
        modelId:
          type: string
          description: The id exactly as stored (it may be a bare, non-canonical id).
        provider:
          type: string
          description: >-
            The case entry's provider hint, kept so the stored `{ model,
            provider }` pair survives the round trip.
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
    Conflict:
      description: >-
        The resource is not in a state that accepts this write — a stale
        `expectedRevision`, a duplicate name, or an environment that cannot
        currently be launched. The request was well-formed; re-read the resource
        and retry.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            code: CONFLICT
            message: >-
              Environment changed since you loaded it (expected revision 3,
              current 5). Reload and retry.
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