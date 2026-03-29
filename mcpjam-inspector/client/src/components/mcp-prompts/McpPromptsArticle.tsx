import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

export function McpPromptsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Prompts"
        subtitle="Prompts are reusable templates the user can choose."
      />

      <Section step={1} title="What a Prompt Is">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A prompt is a reusable setup for a conversation, like “review this
          code” or “summarize this doc.” In MCP, prompts are user-controlled.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>The user chooses the prompt.</li>
          <li>A prompt can have a name, description, and arguments.</li>
          <li>Hosts often show prompts as slash commands or menu items.</li>
        </ul>
      </Section>

      <Section step={2} title="How Prompts Load">
        <p className="text-sm text-muted-foreground leading-relaxed">
          The client first asks the server which prompts exist. When the user
          picks one, the client asks the server to build the final prompt with
          any provided arguments.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            <code>prompts/list</code> shows what is available.
          </li>
          <li>
            <code>prompts/get</code> returns the final messages.
          </li>
          <li>
            The server can notify the client when the prompt list changes.
          </li>
        </ul>
      </Section>

      <Section step={3} title="What a Prompt Can Return">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A prompt can return one or more messages, not just one string. That
          makes it useful for richer workflows.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Messages can have user or assistant roles.</li>
          <li>Content can include text and other media types.</li>
          <li>Prompts can also reference MCP resources for fresh context.</li>
        </ul>

        <Aside>
          That means a code review prompt can pull in the latest file contents
          instead of relying on stale pasted text.
        </Aside>
      </Section>

      <Section step={4} title="Arguments">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Arguments let one prompt template handle many cases. Instead of making
          many near-duplicate prompts, you keep one template and fill in values.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Arguments are simple string values.</li>
          <li>The server can mark them required or optional.</li>
          <li>Clients can request auto-complete suggestions for them.</li>
        </ul>

        <Aside>
          A single “review code” prompt can take a language argument instead of
          needing one prompt for each language.
        </Aside>
      </Section>

      <Section step={5} title="How Prompts Fit In">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Prompts are one of MCP’s three main primitives. Tools do actions,
          resources provide context, and prompts give the user a reusable way to
          start a good workflow.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Tools are model-controlled.</li>
          <li>Resources are host-controlled.</li>
          <li>Prompts are user-controlled.</li>
        </ul>

        <Aside>
          A strong MCP server often uses all three: prompts for setup, resources
          for context, and tools for actions.
        </Aside>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP Tools</span> and{" "}
        <span className="font-medium text-foreground/70">MCP Resources</span> to
        round out the three core MCP building blocks.
      </ArticleOutro>
    </div>
  );
}
