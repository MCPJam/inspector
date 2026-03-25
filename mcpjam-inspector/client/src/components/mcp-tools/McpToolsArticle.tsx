import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

export function McpToolsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Tools"
        subtitle="Tools are model-controlled actions that let AI invoke real operations on external systems. Learn how tools are discovered, invoked, and secured through the MCP protocol."
      />

      {/* Section 1: What Are Tools? */}
      <Section step={1} title="What Are Tools?">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tools are one of MCP's three server primitives. They represent
          executable actions that an AI model can decide to invoke during a
          conversation. Unlike resources (which the host application controls)
          or prompts (which the user selects), tools are{" "}
          <strong>model-controlled</strong> — the LLM autonomously decides when
          and how to call them based on conversation context. Think of them like
          functions in a programming language: the model reads the signature,
          decides when to call, and uses the return value to continue reasoning.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Each tool has a name, description, and JSON Schema for its inputs.</li>
          <li>Servers declare tool support during capability negotiation at connection initialization.</li>
          <li>The host application can add human-in-the-loop confirmation before execution.</li>
        </ul>
      </Section>

      {/* Section 2: Discovery and Invocation */}
      <Section step={2} title="Discovery and Invocation">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tool interaction follows a two-phase pattern. First, the client
          discovers available tools via <code>tools/list</code>. The server
          returns an array of tool definitions including name, description, and{" "}
          <code>inputSchema</code>. Then, when the model decides to use a tool,
          the client sends a <code>tools/call</code> request with the tool name
          and arguments. The server validates, executes, and returns the result.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Discovery: clients call <code>tools/list</code> to get all available tools with their schemas.</li>
          <li>Invocation: clients call <code>tools/call</code> with {"{ name, arguments }"} and receive a result.</li>
          <li>Pagination: <code>tools/list</code> supports a cursor parameter for servers with many tools.</li>
          <li>Dynamic updates: servers can notify clients via <code>notifications/tools/list_changed</code> when tools are added or removed.</li>
        </ul>

        <Aside>
          The <code>tools/list</code> response includes everything the model
          needs to decide whether and how to call a tool — the description and{" "}
          <code>inputSchema</code> are injected into the model's context as
          available function definitions.
        </Aside>
      </Section>

      {/* Section 3: Tool Results and Content Types */}
      <Section step={3} title="Tool Results and Content Types">
        <p className="text-sm text-muted-foreground leading-relaxed">
          When a tool executes, it returns a structured result containing an
          array of content items. MCP supports multiple content types in a
          single response, letting tools return rich, multi-modal results — a
          status message, a screenshot, and a link to a file, all in one response.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Text content: plain text or structured data like JSON, Markdown, or logs.</li>
          <li>Image content: base64-encoded images with a MIME type (e.g., PNG, JPEG) for charts or screenshots.</li>
          <li>Audio content: base64-encoded audio with a MIME type for voice or sound data.</li>
          <li>Embedded resources: inline resource data (text or binary) that can be referenced by URI.</li>
          <li>isError flag: when true, indicates the tool executed but encountered a domain error — the result contains the error message.</li>
        </ul>
      </Section>

      {/* Section 4: Error Handling */}
      <Section step={4} title="Error Handling">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP distinguishes between two types of errors.{" "}
          <strong>Protocol-level errors</strong> (like a malformed request or an
          unknown tool name) are returned as JSON-RPC errors and indicate
          something went wrong with the communication itself.{" "}
          <strong>Tool execution errors</strong> (like "user not found" or
          "permission denied") are returned inside a normal tool result with the{" "}
          <code>isError</code> flag set to <code>true</code>. This distinction
          matters because tool execution errors are visible to the model and can
          inform its next steps.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Protocol errors: JSON-RPC error responses for invalid tool names, malformed arguments, or server failures.</li>
          <li>Tool execution errors: normal results with <code>isError: true</code> — the model sees the error and can adapt.</li>
          <li>The model can retry, try a different tool, or ask the user for clarification based on execution errors.</li>
          <li>Servers should never surface raw exceptions — always return structured, meaningful error messages.</li>
        </ul>

        <Aside>
          Set <code>isError: true</code> for domain errors (bad input, not
          found, unauthorized). Use JSON-RPC errors only for protocol failures.
          The model can reason about tool errors but not protocol errors.
        </Aside>
      </Section>

      {/* Section 5: Security Best Practices */}
      <Section step={5} title="Security Best Practices">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tools are the most security-sensitive MCP primitive because they
          perform actions with real-world side effects. Every tool invocation
          should be treated as potentially dangerous — the model chooses what to
          call, but the server decides what to allow.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Input validation: always validate arguments against the schema before execution. Never trust model-generated input.</li>
          <li>Access controls: enforce authentication, authorization, and rate limiting on every tool call.</li>
          <li>Human-in-the-loop: for destructive or irreversible operations, require user confirmation before execution.</li>
          <li>Least privilege: tools should request minimal permissions. A read-only tool should never have write access.</li>
          <li>Annotations: use readOnlyHint, destructiveHint, and idempotentHint to communicate a tool's safety profile to the client.</li>
        </ul>
      </Section>

      <ArticleOutro>
        Next up: learn about{" "}
        <span className="font-medium text-foreground/70">MCP Resources</span>{" "}
        (data the host provides as context) and{" "}
        <span className="font-medium text-foreground/70">MCP Prompts</span>{" "}
        (templates the user selects).
      </ArticleOutro>
    </div>
  );
}
