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
import { WhyMcpConnectedDiagram } from "./WhyMcpConnectedDiagram";
import { WhyMcpGovernanceDiagram } from "./WhyMcpGovernanceDiagram";
import { WhyMcpNxMDiagram } from "./WhyMcpNxMDiagram";
import { WhyMcpProblemDiagram } from "./WhyMcpProblemDiagram";
import { WhyMcpToolCallingDiagram } from "./WhyMcpToolCallingDiagram";

// ---------------------------------------------------------------------------
// Category accents (article-specific)
// ---------------------------------------------------------------------------

const CATEGORY_ACCENT = {
  problem: "#ef4444", // red
  foundation: "#8b5cf6", // purple
  challenge: "#f59e0b", // amber
  solution: "#3b82f6", // blue
} as const;

type Category = keyof typeof CATEGORY_ACCENT;

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function WhyMcpArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="Why We Need MCP"
        subtitle="From isolated AI models to a universal standard for tool integration. Understand why LLMs need tools, why agents need governance, and why the industry needs MCP."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: The Problem */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="problem"
        categoryColor={CATEGORY_ACCENT.problem}
        step={1}
        title="The Problem: Smart Models, No Hands"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Large Language Models are remarkably capable — they can reason, write
          code, analyze data, and hold nuanced conversations. But out of the
          box, they're trapped inside a text-in, text-out loop. They can't check
          your database, file an Asana task, query your monitoring dashboard, or
          deploy your code. They can only talk <em>about</em> doing those
          things.
        </motion.p>

        <AnalogyCallout>
          An LLM without tools is a brain in a jar. It can think brilliantly,
          but it can't interact with the world. Tool calling gives it hands.
        </AnalogyCallout>

        <KeyDetails
          items={[
            "LLMs can reason, write, and analyze — but they cannot act on external systems.",
            "The gap between 'talking about doing something' and 'actually doing it' is the core limitation.",
            "To make AI useful in engineering workflows, models need the ability to act — not just think.",
          ]}
        />

        <motion.div className="space-y-2" {...sectionChild(5)}>
          <WhyMcpProblemDiagram />
          <p className="text-center text-[12px] text-muted-foreground/80 leading-relaxed">
            LLMs can reason about databases, APIs, and services — but they can't
            reach them.
          </p>
        </motion.div>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: Tool Calling */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="foundation"
        categoryColor={CATEGORY_ACCENT.foundation}
        step={2}
        title="What is Tool Calling?"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Tool calling (sometimes called "function calling") is the mechanism
          that lets an AI model invoke external functions during a conversation.
          Instead of just generating text, the model can decide:{" "}
          <em>
            "I need to call a function to get real data before I respond."
          </em>
        </motion.p>

        <KeyDetails
          items={[
            "You describe available tools to the model (name, description, input schema).",
            "The model decides when to call a tool and outputs a structured call — not free-form text.",
            "Your application executes that function and returns the result to the model.",
            "The model incorporates the real data into its response.",
          ]}
        />

        <motion.div className="space-y-2" {...sectionChild(5)}>
          <WhyMcpToolCallingDiagram />
        </motion.div>

        <Tip>
          This is the foundation that makes AI agents possible. An agent is just
          a model that can reason about <em>which</em> tools to use,{" "}
          <em>when</em> to use them, and <em>how</em> to chain them together to
          accomplish a goal.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: Governance */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="challenge"
        categoryColor={CATEGORY_ACCENT.challenge}
        step={3}
        title="Why Agents Need Governance"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Once you give an agent tools, two critical questions immediately
          arise: <strong>What should this agent be allowed to do?</strong> And{" "}
          <strong>how do you know what it did?</strong>
        </motion.p>

        <motion.div className="space-y-2" {...sectionChild(3)}>
          <WhyMcpGovernanceDiagram />
          <p className="text-center text-[12px] text-muted-foreground/80 leading-relaxed">
            Nothing reaches your systems unless policy allows it — scoped,
            logged, and revocable on every path.
          </p>
        </motion.div>

        <KeyDetails
          items={[
            "Scoped access: the agent should only see tools relevant to its task. Least privilege: read-only access when writes aren't needed.",
            "Per-user authorization: an agent acting on behalf of User A shouldn't have User B's permissions.",
            "Audit trails: a queryable log of every tool call, who triggered it, and what happened.",
            "Revocability: the ability to cut off access instantly if something goes wrong.",
          ]}
        />

        <Tip>
          The core question: <strong>"Who is your agent acting for?"</strong> A
          developer automating their own workflow has different requirements
          than an agent acting on behalf of thousands of customers. The latter
          demands protocol-level governance that ad-hoc solutions can't provide.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 4: The N×M Problem */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="challenge"
        categoryColor={CATEGORY_ACCENT.challenge}
        step={4}
        title="The N × M Problem"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          No shared standard means <strong>N × M</strong> integrations—one
          custom link per platform–tool pair—and that cost explodes as{" "}
          <strong>N</strong> or <strong>M</strong> grows.
        </motion.p>

        <motion.div {...sectionChild(3)}>
          <WhyMcpNxMDiagram />
        </motion.div>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 5: Enter MCP */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="solution"
        categoryColor={CATEGORY_ACCENT.solution}
        step={5}
        title="Enter MCP: The Universal Standard"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          The <strong>Model Context Protocol (MCP)</strong> is an open standard
          introduced by Anthropic that defines how AI applications communicate
          with external tools and data sources. It provides a single, consistent
          protocol for tool integration — replacing the patchwork of custom
          adapters.
        </motion.p>

        <AnalogyCallout>
          MCP is USB-C for AI integrations. One cable works everywhere. One
          protocol connects everything.
        </AnalogyCallout>

        <KeyDetails
          items={[
            "MCP reduces N × M to N + M. Build one MCP server for your tool, and it works with every MCP-compatible client.",
            "Communication happens over JSON-RPC, using either stdio (local tools) or HTTP with Server-Sent Events (remote services).",
            "Three components: MCP Host (the AI application), MCP Client (protocol bridge), MCP Server (tool wrapper).",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 6: What MCP Exposes */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="solution"
        categoryColor={CATEGORY_ACCENT.solution}
        step={6}
        title="What MCP Servers Expose"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          An MCP server can provide three types of capabilities:
        </motion.p>

        <KeyDetails
          items={[
            "Tools: Actions the model can invoke — create_issue, send_message, run_query. Model-controlled: the AI decides when to use them.",
            "Resources: Read-only data the model can access — file contents, database schemas, documentation. Application-controlled: the host decides what to include.",
            "Prompts: Reusable templates that help the model interact with tools effectively. User-controlled: the user selects which prompt to use.",
          ]}
        />

        <Tip>
          Ready to go deeper? The <strong>"What is MCP?"</strong> walkthrough
          explores the full host → client → server architecture with an
          interactive diagram.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 7: Conclusion */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="solution"
        categoryColor={CATEGORY_ACCENT.solution}
        step={7}
        title="The Bottom Line"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          MCP isn't replacing your CLI, your APIs, or your prompt files. It's
          the standardization layer that was missing — the thing that turns
          isolated AI models into production-ready agents that can safely and
          reliably interact with the real world.
        </motion.p>

        <KeyDetails
          items={[
            "Tool calling gives models the ability to act.",
            "MCP standardizes how those actions are defined, discovered, authorized, and audited.",
            "CLI, APIs, and Skills remain valuable — MCP complements them by solving the governance and interoperability problems they weren't designed to address.",
          ]}
        />

        <motion.div className="space-y-2" {...sectionChild(5)}>
          <WhyMcpConnectedDiagram />
          <p className="text-center text-[12px] text-muted-foreground/80 leading-relaxed">
            With MCP, the same model reaches real systems through a governed,
            standardized bridge.
          </p>
        </motion.div>

        <motion.p
          className="text-sm text-foreground/70 leading-relaxed font-medium italic"
          {...sectionChild(5)}
        >
          The bottleneck for AI agents was never intelligence — it was
          connectivity. MCP removes that bottleneck.
        </motion.p>
      </Section>

      {/* Outro */}
      <ArticleOutro>
        Next up: explore the{" "}
        <span className="font-medium text-foreground/70">What is MCP?</span>{" "}
        walkthrough to see the architecture in action.
      </ArticleOutro>
    </div>
  );
}
