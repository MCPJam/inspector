import {
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { ComparisonTable } from "@/components/learning-article/ComparisonTable";

export function McpVsSkillsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP vs Skills"
        subtitle="Skills teach agents how to think. MCP gives them access to act. Learn why they're complementary, not competing, and how the best setups use both."
      />

      {/* Section 1: The Comparison */}
      <Section step={1} title="Skills: Teaching Agents How to Think">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Skills (also known as prompt files, <code>.cursorrules</code>,{" "}
          <code>CLAUDE.md</code>, etc.) are markdown documents that encode
          knowledge and best practices for AI agents. They teach agents{" "}
          <em>how</em> to perform tasks effectively — but they don't give agents
          access to external systems.
        </p>

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

      {/* Section 2: Complementary, Not Competing */}
      <Section step={2} title="Complementary, Not Competing">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Skills make agents smarter about <em>how</em> to use tools. MCP gives
          agents <em>access</em> to tools. The best setups use both: a skill
          teaching the agent best practices for GitHub workflows, combined with
          an MCP server that gives it authenticated access to GitHub. A skill is
          a playbook. MCP is the field.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Skills encode domain expertise — "when deploying, always run
            migrations first."
          </li>
          <li>
            MCP provides the actual connection to run those migrations through
            authenticated tool calls.
          </li>
          <li>
            Without skills, agents have access but lack judgment. Without MCP,
            agents have judgment but can't act.
          </li>
        </ul>
      </Section>

      {/* Section 3: The Bottom Line */}
      <Section step={3} title="The Bottom Line">
        <p className="text-sm text-muted-foreground leading-relaxed">
          There's a lot of helpful data behind auth. MCP gives agents access to
          that data. Skills tell them what to do with it.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Use skills to teach agents domain expertise and best practices.
          </li>
          <li>
            Use MCP to give agents authenticated, scoped access to external
            systems.
          </li>
          <li>
            The most effective agent setups combine both — knowledge and access
            working together.
          </li>
        </ul>
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
