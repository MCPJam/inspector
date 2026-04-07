import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { ComparisonTable } from "@/components/learning-article/ComparisonTable";

export function McpVsApiArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP vs REST APIs"
        subtitle="MCP does not replace APIs. It gives AI a cleaner way to use them."
      />

      <Section step={1} title="Quick Comparison">
        <p className="text-sm text-muted-foreground leading-relaxed">
          REST APIs are still the systems many apps expose. MCP sits on top and
          makes those systems easier for AI hosts to discover and use.
        </p>

        <ComparisonTable
          headers={["Aspect", "REST API", "MCP"]}
          rows={[
            {
              cells: [
                "Discovery",
                "Usually docs and custom code",
                "Tool and resource discovery at runtime",
              ],
            },
            {
              cells: [
                "Context",
                "You pass it manually",
                "The conversation can carry it across calls",
              ],
            },
            {
              cells: [
                "Integration effort",
                "Per API integration",
                "One protocol across many servers",
              ],
            },
            {
              cells: [
                "Connection model",
                "Typical request/response",
                "Protocol built for ongoing host-server interaction",
              ],
            },
          ]}
        />
      </Section>

      <Section step={2} title="MCP Wraps APIs">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP servers often call REST APIs under the hood. So MCP is not a
          replacement for APIs. It is an AI-friendly layer in front of them.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>The API still does the real backend work.</li>
          <li>The MCP server translates that work into tools and resources.</li>
          <li>
            The host gets one consistent interface instead of many custom ones.
          </li>
        </ul>
      </Section>

      <Section step={3} title="Why That Helps">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Imagine an agent that needs GitHub, Jira, and Slack. With raw APIs,
          you manage three integrations. With MCP, the host talks one protocol
          while each server handles its own backend details.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>The host does not need a new custom flow for every service.</li>
          <li>The model can discover tools at runtime.</li>
          <li>
            Context can carry across multiple tool calls in one conversation.
          </li>
        </ul>
      </Section>

      <Section step={4} title="Simple Rule">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Keep building APIs for your product. Add MCP when you want AI hosts to
          use those systems through a standard agent-friendly interface.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Use raw APIs when you are integrating one known service directly.
          </li>
          <li>Use MCP when AI needs a shared protocol for many tools.</li>
          <li>You often want both: APIs underneath, MCP on top.</li>
        </ul>

        <Aside>
          The easy mental model: APIs are the backend surface; MCP is the AI
          integration layer in front of that surface.
        </Aside>
      </Section>

      <ArticleOutro>
        Next: compare MCP with{" "}
        <span className="font-medium text-foreground/70">CLI</span> and{" "}
        <span className="font-medium text-foreground/70">Skills</span> to see
        the rest of the tradeoffs.
      </ArticleOutro>
    </div>
  );
}
