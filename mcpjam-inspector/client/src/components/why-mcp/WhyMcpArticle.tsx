import { Lightbulb, Info, Zap } from "lucide-react";
import { motion } from "framer-motion";
import { WhyMcpConnectedDiagram } from "./WhyMcpConnectedDiagram";
import { WhyMcpGovernanceDiagram } from "./WhyMcpGovernanceDiagram";
import { WhyMcpNxMDiagram } from "./WhyMcpNxMDiagram";
import { WhyMcpProblemDiagram } from "./WhyMcpProblemDiagram";
import { WhyMcpToolCallingDiagram } from "./WhyMcpToolCallingDiagram";

// ---------------------------------------------------------------------------
// Animation helpers (same pattern as WhatIsMcpGuide)
// ---------------------------------------------------------------------------

const EASE = [0.25, 0.1, 0.25, 1] as const;

function sectionChild(order: number) {
  return {
    initial: { opacity: 0, y: 16 } as const,
    whileInView: { opacity: 1, y: 0 } as const,
    viewport: { once: true } as const,
    transition: {
      delay: order * 0.08,
      duration: 0.4,
      ease: EASE,
    },
  };
}

// ---------------------------------------------------------------------------
// Category accents
// ---------------------------------------------------------------------------

const CATEGORY_ACCENT = {
  problem: "#ef4444", // red
  foundation: "#8b5cf6", // purple
  challenge: "#f59e0b", // amber
  solution: "#3b82f6", // blue
} as const;

type Category = keyof typeof CATEGORY_ACCENT;

// ---------------------------------------------------------------------------
// Reusable callout sub-components
// ---------------------------------------------------------------------------

function AnalogyCallout({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="rounded-lg border border-indigo-200/50 dark:border-indigo-800/30 bg-indigo-50/40 dark:bg-indigo-950/10 p-4"
      {...sectionChild(3)}
    >
      <div className="flex items-center gap-2 mb-2">
        <Zap className="h-3.5 w-3.5 text-indigo-500/70" />
        <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider">
          Analogy
        </span>
      </div>
      <p className="text-[13px] text-foreground/80 leading-relaxed">
        {children}
      </p>
    </motion.div>
  );
}

function KeyDetails({ items }: { items: string[] }) {
  return (
    <motion.div
      className="rounded-lg border border-blue-200/50 dark:border-blue-800/30 bg-blue-50/40 dark:bg-blue-950/10 p-4"
      {...sectionChild(4)}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <Info className="h-3.5 w-3.5 text-blue-500/70" />
        <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
          Key details
        </span>
      </div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[13px] text-foreground/80 leading-relaxed"
          >
            <span className="mt-1.5 block h-1 w-1 rounded-full bg-blue-400/60 shrink-0" />
            {item}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="rounded-lg border border-amber-200/50 dark:border-amber-800/30 bg-amber-50/40 dark:bg-amber-950/10 p-4"
      {...sectionChild(6)}
    >
      <div className="flex items-center gap-2 mb-2">
        <Lightbulb className="h-3.5 w-3.5 text-amber-500/70" />
        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wider">
          Tip
        </span>
      </div>
      <p className="text-[13px] text-foreground/80 leading-relaxed">
        {children}
      </p>
    </motion.div>
  );
}

function Section({
  category,
  step,
  title,
  children,
}: {
  category: Category;
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  const color = CATEGORY_ACCENT[category];

  return (
    <motion.section
      className="relative py-12 first:pt-6"
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.5, ease: EASE }}
    >
      <div className="space-y-5">
        {/* Category badge + step number */}
        <motion.div className="flex items-center gap-2" {...sectionChild(0)}>
          <span
            className="block h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span
            className="text-[11px] font-semibold uppercase tracking-wider"
            style={{ color }}
          >
            {category}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono">
            Section {step}
          </span>
        </motion.div>

        {/* Title */}
        <motion.h2
          className="text-xl font-semibold tracking-tight text-foreground -mt-1"
          {...sectionChild(1)}
        >
          {title}
        </motion.h2>

        {children}
      </div>

      {/* Section divider */}
      <div className="mt-12 border-b border-border/30" />
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function WhyMcpArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      {/* Hero */}
      <div className="pt-8 pb-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="space-y-3"
        >
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Why We Need MCP
          </h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            From isolated AI models to a universal standard for tool
            integration. Understand why LLMs need tools, why agents need
            governance, and why the industry needs MCP.
          </p>
        </motion.div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: The Problem */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="problem"
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
      <Section category="foundation" step={2} title="What is Tool Calling?">
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
      <Section category="challenge" step={3} title="Why Agents Need Governance">
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
      <Section category="challenge" step={4} title="The N × M Problem">
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
      <Section category="solution" step={6} title="What MCP Servers Expose">
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
      <Section category="solution" step={7} title="The Bottom Line">
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
      <motion.div
        className="pt-4 pb-8 text-center"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <p className="text-sm text-muted-foreground/60">
          Next up: explore the{" "}
          <span className="font-medium text-foreground/70">What is MCP?</span>{" "}
          walkthrough to see the architecture in action.
        </p>
      </motion.div>
    </div>
  );
}
