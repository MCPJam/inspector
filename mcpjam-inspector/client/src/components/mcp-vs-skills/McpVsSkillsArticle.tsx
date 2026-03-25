import { motion } from "framer-motion";
import {
  sectionChild,
  AnalogyCallout,
  KeyDetails,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { ComparisonTable } from "@/components/learning-article/ComparisonTable";

// ---------------------------------------------------------------------------
// Category accent
// ---------------------------------------------------------------------------

const COLOR = "#10b981"; // emerald

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function McpVsSkillsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP vs Skills"
        subtitle="Skills teach agents how to think. MCP gives them access to act. Learn why they're complementary, not competing, and how the best setups use both."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: The Comparison */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={1}
        title="Skills: Teaching Agents How to Think"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Skills (also known as prompt files, <code>.cursorrules</code>,{" "}
          <code>CLAUDE.md</code>, etc.) are markdown documents that encode
          knowledge and best practices for AI agents. They teach agents{" "}
          <em>how</em> to perform tasks effectively — but they don't give agents
          access to external systems.
        </motion.p>

        <ComparisonTable
          headers={["Aspect", "Skills", "MCP"]}
          rows={[
            {
              cells: [
                "What they provide",
                "Knowledge — best practices, decision trees, tribal knowledge",
                "Access — authenticated, scoped connections to external services",
              ],
            },
            {
              cells: [
                "Format",
                "Markdown documents",
                "Protocol with servers, clients, and structured communication",
              ],
            },
            {
              cells: [
                "Auth",
                "None — they're just text",
                "OAuth 2.1, scoped tokens, revocable access",
              ],
            },
            {
              cells: [
                "Data access",
                "None — they describe, they don't connect",
                "Direct connection to live systems behind auth",
              ],
            },
            {
              cells: [
                "Example",
                '"When writing React components, follow these 20 rules..."',
                '"Connect to the user\'s GitHub and create a PR on their behalf"',
              ],
            },
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: Complementary, Not Competing */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={2}
        title="Complementary, Not Competing"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Skills make agents smarter about <em>how</em> to use tools. MCP gives
          agents <em>access</em> to tools. The best setups use both: a skill
          teaching the agent best practices for GitHub workflows, combined with
          an MCP server that gives it authenticated access to GitHub.
        </motion.p>

        <AnalogyCallout>
          A skill is a playbook. MCP is the field. The playbook tells the agent
          what to do — MCP lets it actually do it.
        </AnalogyCallout>

        <KeyDetails
          items={[
            'Skills encode domain expertise — "when deploying, always run migrations first."',
            "MCP provides the actual connection to run those migrations through authenticated tool calls.",
            "Without skills, agents have access but lack judgment. Without MCP, agents have judgment but can't act.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: The Bottom Line */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={3}
        title="The Bottom Line"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          There's a lot of helpful data behind auth. MCP gives agents access to
          that data. Skills tell them what to do with it.
        </motion.p>

        <KeyDetails
          items={[
            "Use skills to teach agents domain expertise and best practices.",
            "Use MCP to give agents authenticated, scoped access to external systems.",
            "The most effective agent setups combine both — knowledge and access working together.",
          ]}
        />
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP vs CLI</span> and{" "}
        <span className="font-medium text-foreground/70">MCP vs REST APIs</span>{" "}
        for the full picture.
      </ArticleOutro>
    </div>
  );
}
