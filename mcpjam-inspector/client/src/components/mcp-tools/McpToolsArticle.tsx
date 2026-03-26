import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

export function McpToolsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Tools"
        subtitle="Tools are how AI asks MCP servers to do real work."
      />

      <Section step={1} title="What a Tool Is">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A tool is an action the model can ask the server to run, like search,
          send, create, or query. In MCP, tools are the action part of the
          system.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Each tool has a name, description, and input schema.</li>
          <li>The model decides when to use it.</li>
          <li>The host can still require user approval before running it.</li>
        </ul>
      </Section>

      <Section step={2} title="How Tools Run">
        <p className="text-sm text-muted-foreground leading-relaxed">
          The client first asks the server which tools exist. Later, when the
          model picks one, the client sends a request to call it with arguments.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            <code>tools/list</code> shows the available tools.
          </li>
          <li>
            <code>tools/call</code> runs one tool with arguments.
          </li>
          <li>The server can notify the client if the tool list changes.</li>
        </ul>

        <Aside>
          Good tool descriptions matter. The model uses them to decide which
          tool to call.
        </Aside>
      </Section>

      <Section step={3} title="What a Tool Returns">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tool results can be more than plain text. A tool can return text,
          images, audio, or embedded resource data.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Text is the most common result type.</li>
          <li>
            Images or other rich data are useful for charts, screenshots, or
            media.
          </li>
          <li>A tool result can also mark itself as an error.</li>
        </ul>
      </Section>

      <Section step={4} title="Errors">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP separates protocol problems from tool problems. That matters
          because the model can reason about a tool error, but not about a
          broken protocol exchange.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Bad requests use JSON-RPC errors.</li>
          <li>
            Domain problems like “user not found” use normal tool results with{" "}
            <code>isError</code>.
          </li>
          <li>
            Clear error messages help the model recover or ask better
            follow-ups.
          </li>
        </ul>

        <Aside>
          Use <code>isError: true</code> when the tool ran but could not finish
          the job.
        </Aside>
      </Section>

      <Section step={5} title="Safety Basics">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tools are powerful because they can change real systems. That means
          every tool needs validation, permissions, and clear safety rules.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Validate every argument before running the tool.</li>
          <li>Check auth and permissions on every call.</li>
          <li>Ask for confirmation before destructive actions.</li>
        </ul>
      </Section>

      <ArticleOutro>
        Next up: compare tools with{" "}
        <span className="font-medium text-foreground/70">Resources</span> and{" "}
        <span className="font-medium text-foreground/70">Prompts</span> so you
        know when to use each one.
      </ArticleOutro>
    </div>
  );
}
