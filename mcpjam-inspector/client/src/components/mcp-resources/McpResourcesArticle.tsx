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
        subtitle="Resources are application-controlled data that provide context to AI models. Learn how servers expose structured data through URIs, templates, subscriptions, and multiple content types."
      />

      {/* Section 1: What Are Resources? */}
      <Section step={1} title="What Are Resources?">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Resources represent data that an MCP server makes available for
          reading. Unlike tools (which the model invokes) and prompts (which the
          user selects), resources are <strong>application-controlled</strong> —
          the host application or its user decides which resources to include in
          the model's context. They are designed to provide the AI with the
          information it needs to reason effectively — like reference documents
          on your desk that you decide which to put in front of the AI.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Resources are application-controlled: the host decides what context to attach, not the model.</li>
          <li>Each resource is identified by a unique URI (e.g., <code>file:///logs/app.log</code>, <code>postgres://db/schema</code>).</li>
          <li>Resources can contain text (UTF-8 strings) or binary data (base64-encoded).</li>
          <li>Common examples: file contents, database schemas, API responses, live system data, screenshots.</li>
        </ul>
      </Section>

      {/* Section 2: Discovery — Listing and Templates */}
      <Section step={2} title="Discovery: Listing and Templates">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Servers offer two discovery mechanisms.{" "}
          <strong>Direct resources</strong> are concrete items listed via{" "}
          <code>resources/list</code> — each has a fixed URI and can be read
          immediately. <strong>Resource templates</strong>, listed via{" "}
          <code>resources/templates/list</code>, describe parameterized URIs
          using RFC 6570 syntax (e.g.,{" "}
          <code>{"users://{user_id}/profile"}</code>). Templates let clients
          construct URIs dynamically, enabling access to large or unbounded
          collections of data without listing every possible resource upfront.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li><code>resources/list</code>: returns concrete resources the server currently exposes, each with a URI, name, and optional description and MIME type.</li>
          <li><code>resources/templates/list</code>: returns URI templates with parameters, like <code>{"file:///{path}"}</code> or <code>{"db:///{table}/{id}"}</code>.</li>
          <li>Templates use RFC 6570 URI Template syntax for parameter substitution.</li>
          <li>Both endpoints support pagination via cursors for servers with many items.</li>
          <li>Servers can emit <code>notifications/resources/list_changed</code> when available resources change.</li>
        </ul>

        <Aside>
          Use direct resources for well-known, stable data (e.g., a system
          configuration file). Use templates for dynamic collections where the
          set of valid URIs is large or changes frequently (e.g., user profiles,
          database rows).
        </Aside>
      </Section>

      {/* Section 3: Reading Resources */}
      <Section step={3} title="Reading Resources">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Clients read resources by sending a <code>resources/read</code>{" "}
          request with the resource URI. The server returns the resource's
          contents — either text (returned as a UTF-8 string) or binary data
          (returned as base64-encoded bytes with a MIME type). A single read can
          return multiple content items, allowing a resource to bundle related
          data together.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Text resources: returned as {"{ uri, mimeType, text }"} — ideal for source code, logs, JSON, Markdown.</li>
          <li>Binary resources: returned as {"{ uri, mimeType, blob }"} with base64-encoded data — for images, PDFs, audio.</li>
          <li>A server must return at least one content item per read request.</li>
          <li>The URI in the response may differ from the request URI (e.g., after following a redirect or resolving a template).</li>
        </ul>
      </Section>

      {/* Section 4: URI Schemes and Subscriptions */}
      <Section step={4} title="URI Schemes and Subscriptions">
        <p className="text-sm text-muted-foreground leading-relaxed">
          MCP does not mandate specific URI schemes — servers can use any scheme
          that makes sense for their domain. The protocol also supports{" "}
          <strong>subscriptions</strong>, where the client can subscribe to
          change notifications for specific resources and receive real-time
          updates when the underlying data changes.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Common URI schemes: <code>https://</code> (web APIs), <code>file://</code> (local files), <code>git://</code> (repositories), <code>postgres://</code> (databases).</li>
          <li>Servers can define custom schemes like <code>myapp://settings</code> or <code>project://build-config</code>.</li>
          <li>Subscriptions: clients call <code>resources/subscribe</code> with a URI to get notified when that resource changes.</li>
          <li>When a subscribed resource changes, the server sends <code>notifications/resources/updated</code>.</li>
          <li>Clients can call <code>resources/unsubscribe</code> to stop receiving updates.</li>
        </ul>
      </Section>

      {/* Section 5: Resources vs. Tools */}
      <Section step={5} title="Resources vs. Tools">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A common question: when should you expose something as a resource
          versus a tool? The answer depends on control and purpose. Resources
          are for providing context data — they load information the model needs
          to reason. Tools are for performing actions — they execute operations
          with side effects.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>Use resources when: loading data into context, providing reference information, sharing file or database contents.</li>
          <li>Use tools when: the operation has side effects, modifies state, or requires model-driven decision-making.</li>
          <li>Resources are read by the application to build context. Tools are called by the model to take action.</li>
          <li>Example: a database schema is a resource (context). Running a query is a tool (action).</li>
        </ul>

        <Aside>
          If you find yourself creating a tool that just returns data with no
          side effects, consider making it a resource instead. Resources give
          the host application more control over when and how data enters the
          model's context.
        </Aside>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP Tools</span>{" "}
        (model-controlled actions) and{" "}
        <span className="font-medium text-foreground/70">MCP Prompts</span>{" "}
        (user-controlled templates).
      </ArticleOutro>
    </div>
  );
}
