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
        subtitle="Skills tell an agent how to work. MCP gives it access to real systems."
      />

      <Section step={1} title="Quick Comparison">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Skills and MCP solve different problems. Skills are instructions. MCP
          is connectivity.
        </p>

        <ComparisonTable
          headers={["Aspect", "Skills", "MCP"]}
          rows={[
            {
              cells: [
                "What they provide",
                "Knowledge and instructions",
                "Live access to tools and data",
              ],
            },
            {
              cells: [
                "Format",
                "Usually markdown or prompt files",
                "A protocol with clients and servers",
              ],
            },
            {
              cells: [
                "Authentication",
                "None",
                "Scoped access to real systems",
              ],
            },
            {
              cells: ["Real actions", "No", "Yes"],
            },
          ]}
        />
      </Section>

      <Section step={2} title="Why They Work Together">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Skills make the agent smarter about what to do. MCP makes it possible
          to actually do it.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>A skill might say how to review a pull request well.</li>
          <li>
            An MCP server gives access to GitHub so the agent can inspect it.
          </li>
          <li>Together, the agent has both judgment and access.</li>
        </ul>
      </Section>

      <Section step={3} title="Simple Rule">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use skills to teach repeatable behavior. Use MCP to connect the agent
          to the systems where that behavior needs to happen.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Skills are the playbook.</li>
          <li>MCP is the connection to the field.</li>
          <li>The best agent setups usually use both.</li>
        </ul>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP vs CLI</span> and{" "}
        <span className="font-medium text-foreground/70">MCP vs REST APIs</span>{" "}
        to compare MCP with two other common approaches.
      </ArticleOutro>
    </div>
  );
}
