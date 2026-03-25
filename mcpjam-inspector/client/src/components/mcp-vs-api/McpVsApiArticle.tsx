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
        subtitle="REST APIs are the backbone of modern software. Understand how MCP relates to them — stateless vs. stateful, static vs. dynamic discovery, and why MCP wraps APIs rather than replacing them."
      />

      {/* Section 1: The Comparison */}
      <Section step={1} title="REST APIs: The Backbone of Modern Software">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every SaaS product exposes a REST API. So why not just have agents
          call REST APIs directly? The answer lies in how agents need to
          discover, compose, and maintain context across tool calls.
        </p>

        <ComparisonTable
          headers={["Aspect", "REST API", "MCP"]}
          rows={[
            {
              cells: [
                "State",
                "Stateless — each request is independent",
                "Stateful — maintains context across tool calls",
              ],
            },
            {
              cells: [
                "Connection",
                "One-way request/response",
                "Persistent, bidirectional",
              ],
            },
            {
              cells: [
                "Discovery",
                "Static — you read docs and write integration code",
                "Dynamic — the agent discovers available tools at runtime",
              ],
            },
            {
              cells: [
                "Integration effort",
                "Per-service: auth, pagination, error handling, rate limiting",
                "One protocol, many servers",
              ],
            },
            {
              cells: [
                "Context",
                "Manual — you pass context between API calls yourself",
                "Automatic — the conversation context spans multiple tool uses",
              ],
            },
          ]}
        />
      </Section>

      {/* Section 2: MCP Wraps APIs */}
      <Section step={2} title="Important Nuance: MCP Wraps APIs">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP doesn't replace REST APIs. MCP servers often call REST APIs under
          the hood. MCP is a layer <em>on top of</em> APIs that makes them
          consumable by AI agents — think of it as middleware: REST provides
          discrete services, MCP orchestrates them for agents.
        </p>
      </Section>

      {/* Section 3: Multi-Tool Orchestration */}
      <Section step={3} title="Example: Multi-Tool Orchestration">
        <p className="text-sm text-muted-foreground leading-relaxed">
          An agent needs to check recent commits, create a Jira ticket for a
          bug, and post a summary to Slack. With REST, that's three separate
          integrations with custom auth, pagination, and context threading. With
          MCP, the agent has a unified interface where context flows naturally
          across all three actions in a single conversation.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>REST: 3 separate integrations, 3 auth schemes, manual context threading between calls.</li>
          <li>MCP: 1 protocol, context flows automatically across tool calls within the conversation.</li>
          <li>Each new tool added to MCP is N + 1, not N × M — the integration cost stays linear.</li>
        </ul>
      </Section>

      {/* Section 4: The Bottom Line */}
      <Section step={4} title="The Bottom Line">
        <p className="text-sm text-muted-foreground leading-relaxed">
          REST APIs aren't going anywhere — they're what MCP servers call
          internally. The question is whether your agents should manage raw API
          complexity directly, or work through a protocol designed for
          multi-tool orchestration.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Use REST APIs directly when integrating a single well-known API into a specific app.</li>
          <li>Use MCP when agents need to compose multiple tools with shared context.</li>
          <li>MCP reduces integration cost from N × M to N + M as your tool surface grows.</li>
        </ul>

        <Aside>
          If you're already building MCP servers, they likely wrap REST APIs
          under the hood. You get the best of both worlds — REST's universality
          with MCP's agent-native ergonomics.
        </Aside>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP vs CLI</span> and{" "}
        <span className="font-medium text-foreground/70">MCP vs Skills</span>{" "}
        for the full picture.
      </ArticleOutro>
    </div>
  );
}
