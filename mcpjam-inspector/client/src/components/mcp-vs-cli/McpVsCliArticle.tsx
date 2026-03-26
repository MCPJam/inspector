import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { ComparisonTable } from "@/components/learning-article/ComparisonTable";

export function McpVsCliArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP vs CLI"
        subtitle="CLI is great for fast local work. MCP is better when access and safety need structure."
      />

      <Section step={1} title="Quick Comparison">
        <p className="text-sm text-muted-foreground leading-relaxed">
          CLI tools are simple and fast. MCP adds more structure so tools can be
          shared across hosts and used with clearer auth and safety controls.
        </p>

        <ComparisonTable
          headers={["Aspect", "CLI", "MCP"]}
          rows={[
            {
              cells: [
                "Token efficiency",
                "Very light",
                "Heavier because tool schemas are shared",
              ],
            },
            {
              cells: [
                "Authentication",
                "Usually your current shell credentials",
                "Scoped, explicit access per user or app",
              ],
            },
            {
              cells: [
                "Audit trail",
                "Mostly shell history",
                "Structured logs and clearer attribution",
              ],
            },
            {
              cells: [
                "Multi-user safety",
                "Weak by default",
                "Much better fit",
              ],
            },
          ]}
        />
      </Section>

      <Section step={2} title="When CLI Wins">
        <p className="text-sm text-muted-foreground leading-relaxed">
          CLI is often the best choice when you are automating your own machine
          and you trust the environment.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>You are the only user.</li>
          <li>You want the fastest path from prompt to action.</li>
          <li>Ambient local credentials are acceptable for the task.</li>
        </ul>
      </Section>

      <Section step={3} title="When MCP Wins">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP is the better fit when the agent acts for other people or touches
          shared systems.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>You need per-user access and clearer permissions.</li>
          <li>You need better auditability.</li>
          <li>You need safer reuse across many hosts or tenants.</li>
        </ul>
      </Section>

      <Section step={4} title="Simple Rule">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use CLI for fast personal automation. Use MCP when the tool needs to
          be shared, governed, or used on behalf of someone else.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>CLI is great for local speed.</li>
          <li>MCP is great for reusable, safer integrations.</li>
          <li>Many teams use both in different places.</li>
        </ul>

        <Aside>
          A good default: start with CLI for your own workflow, then move to MCP
          when the workflow needs stronger boundaries.
        </Aside>
      </Section>

      <ArticleOutro>
        Next: compare MCP with{" "}
        <span className="font-medium text-foreground/70">REST APIs</span> and{" "}
        <span className="font-medium text-foreground/70">Skills</span> to see
        where it fits in the wider tool stack.
      </ArticleOutro>
    </div>
  );
}
