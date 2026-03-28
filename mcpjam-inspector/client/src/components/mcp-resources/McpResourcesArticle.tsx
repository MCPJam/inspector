import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

export function McpResourcesArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Resources"
        subtitle="Resources are how hosts give AI read-only context."
      />

      <Section step={1} title="What a Resource Is">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A resource is read-only data the host can give the model, like a file,
          a schema, a document, or an API response. Resources are for context,
          not actions.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>The host chooses which resources to include.</li>
          <li>Each resource has a URI.</li>
          <li>Resources can contain text or binary data.</li>
        </ul>
      </Section>

      <Section step={2} title="How Hosts Discover Them">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Servers can expose direct resources and resource templates. Direct
          resources point to one concrete item. Templates describe a pattern the
          host can fill in later.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            <code>resources/list</code> returns concrete resources.
          </li>
          <li>
            <code>resources/templates/list</code> returns URI templates.
          </li>
          <li>
            The server can notify the client if the available list changes.
          </li>
        </ul>

        <Aside>
          A fixed README file is a direct resource. A pattern like
          <code>{" file:///{path}"}</code> is a template.
        </Aside>
      </Section>

      <Section step={3} title="How Reads Work">
        <p className="text-sm text-muted-foreground leading-relaxed">
          To read a resource, the client sends the URI to the server. The server
          responds with the resource content.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Text resources are great for code, logs, JSON, and Markdown.</li>
          <li>Binary resources work for PDFs, images, or audio.</li>
          <li>A single read can return more than one content item.</li>
        </ul>
      </Section>

      <Section step={4} title="URIs and Updates">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP does not force one URI scheme. Servers can use whatever scheme
          makes sense for the system they wrap, and they can also send update
          notifications when data changes.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Common schemes include <code>file://</code>, <code>https://</code>,
            and database-style URIs.
          </li>
          <li>Custom schemes are fine if they are clear and stable.</li>
          <li>Subscriptions let the client know when a resource changed.</li>
        </ul>
      </Section>

      <Section step={5} title="Resources vs Tools">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use a resource when the AI needs data to read. Use a tool when the AI
          needs to do something.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>A schema or README is a resource.</li>
          <li>Running a query or sending a message is a tool.</li>
          <li>
            If there are no side effects, a resource is often the better fit.
          </li>
        </ul>

        <Aside>
          If a “tool” only returns data and never changes anything, it may
          really want to be a resource.
        </Aside>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP Tools</span> for
        actions and{" "}
        <span className="font-medium text-foreground/70">MCP Prompts</span> for
        reusable workflows.
      </ArticleOutro>
    </div>
  );
}
