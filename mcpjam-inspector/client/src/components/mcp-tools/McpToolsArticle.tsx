import { motion } from "framer-motion";
import {
  sectionChild,
  AnalogyCallout,
  KeyDetails,
  Tip,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

// ---------------------------------------------------------------------------
// Category accent
// ---------------------------------------------------------------------------

const COLOR = "#6366f1"; // indigo

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function McpToolsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Tools"
        subtitle="Tools are model-controlled actions that let AI invoke real operations on external systems. Learn how tools are discovered, invoked, and secured through the MCP protocol."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: What Are Tools? */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={1}
        title="What Are Tools?"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Tools are one of MCP's three server primitives. They represent
          executable actions that an AI model can decide to invoke during a
          conversation. Unlike resources (which the host application controls)
          or prompts (which the user selects), tools are{" "}
          <strong>model-controlled</strong> — the LLM autonomously decides when
          and how to call them based on conversation context.
        </motion.p>

        <AnalogyCallout>
          Tools are like functions in a programming language. The model reads
          the function signature (name, description, parameters), decides when
          to call it, and uses the return value to continue reasoning.
        </AnalogyCallout>

        <KeyDetails
          items={[
            "Tools are model-controlled: the AI decides when to invoke them based on the conversation.",
            "Each tool has a name, description, and JSON Schema for its inputs.",
            "Servers declare tool support during capability negotiation at connection initialization.",
            "The host application can add human-in-the-loop confirmation before execution.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: Discovery and Invocation */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={2}
        title="Discovery and Invocation"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Tool interaction follows a two-phase pattern. First, the client
          discovers available tools via <code>tools/list</code>. The server
          returns an array of tool definitions including name, description, and{" "}
          <code>inputSchema</code>. Then, when the model decides to use a tool,
          the client sends a <code>tools/call</code> request with the tool name
          and arguments. The server validates, executes, and returns the result.
        </motion.p>

        <KeyDetails
          items={[
            "Discovery: clients call tools/list to get all available tools with their schemas.",
            "Invocation: clients call tools/call with { name, arguments } and receive a result.",
            "Pagination: tools/list supports a cursor parameter for servers with many tools.",
            "Dynamic updates: servers can notify clients via notifications/tools/list_changed when tools are added or removed.",
          ]}
        />

        <Tip>
          The <code>tools/list</code> response includes everything the model
          needs to decide whether and how to call a tool — the description and{" "}
          <code>inputSchema</code> are injected into the model's context as
          available function definitions.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: Tool Results and Content Types */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={3}
        title="Tool Results and Content Types"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          When a tool executes, it returns a structured result containing an
          array of content items. MCP supports multiple content types in a
          single response, letting tools return rich, multi-modal results.
        </motion.p>

        <KeyDetails
          items={[
            "Text content: plain text or structured data like JSON, Markdown, or logs.",
            "Image content: base64-encoded images with a MIME type (e.g., PNG, JPEG) for charts or screenshots.",
            "Audio content: base64-encoded audio with a MIME type for voice or sound data.",
            "Embedded resources: inline resource data (text or binary) that can be referenced by URI.",
            "isError flag: when true, indicates the tool executed but encountered a domain error — the result contains the error message.",
          ]}
        />

        <AnalogyCallout>
          A tool result is like a function return value that can contain
          multiple pieces of data — a status message, a screenshot, and a link
          to a file, all in one response.
        </AnalogyCallout>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 4: Error Handling */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={4}
        title="Error Handling"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          MCP distinguishes between two types of errors.{" "}
          <strong>Protocol-level errors</strong> (like a malformed request or an
          unknown tool name) are returned as JSON-RPC errors and indicate
          something went wrong with the communication itself.{" "}
          <strong>Tool execution errors</strong> (like "user not found" or
          "permission denied") are returned inside a normal tool result with the{" "}
          <code>isError</code> flag set to <code>true</code>. This distinction
          matters because tool execution errors are visible to the model and can
          inform its next steps.
        </motion.p>

        <KeyDetails
          items={[
            "Protocol errors: JSON-RPC error responses for invalid tool names, malformed arguments, or server failures.",
            "Tool execution errors: normal results with isError: true — the model sees the error and can adapt.",
            "The model can retry, try a different tool, or ask the user for clarification based on execution errors.",
            "Servers should never surface raw exceptions — always return structured, meaningful error messages.",
          ]}
        />

        <Tip>
          Set <code>isError: true</code> for domain errors (bad input, not
          found, unauthorized). Use JSON-RPC errors only for protocol failures.
          The model can reason about tool errors but not protocol errors.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 5: Security Best Practices */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={5}
        title="Security Best Practices"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Tools are the most security-sensitive MCP primitive because they
          perform actions with real-world side effects. Every tool invocation
          should be treated as potentially dangerous — the model chooses what to
          call, but the server decides what to allow.
        </motion.p>

        <KeyDetails
          items={[
            "Input validation: always validate arguments against the schema before execution. Never trust model-generated input.",
            "Access controls: enforce authentication, authorization, and rate limiting on every tool call.",
            "Human-in-the-loop: for destructive or irreversible operations, require user confirmation before execution.",
            "Least privilege: tools should request minimal permissions. A read-only tool should never have write access.",
            "Annotations: use readOnlyHint, destructiveHint, and idempotentHint to communicate a tool's safety profile to the client.",
          ]}
        />
      </Section>

      {/* Outro */}
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
