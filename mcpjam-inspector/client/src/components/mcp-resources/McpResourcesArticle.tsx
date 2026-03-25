import { motion } from "framer-motion";
import {
  sectionChild,
  AnalogyCallout,
  KeyDetails,
  Tip,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";

// ---------------------------------------------------------------------------
// Category accent
// ---------------------------------------------------------------------------

const COLOR = "#6366f1"; // indigo

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function McpResourcesArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Resources"
        subtitle="Resources are application-controlled data that provide context to AI models. Learn how servers expose structured data through URIs, templates, subscriptions, and multiple content types."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: What Are Resources? */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={1}
        title="What Are Resources?"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Resources represent data that an MCP server makes available for
          reading. Unlike tools (which the model invokes) and prompts (which the
          user selects), resources are <strong>application-controlled</strong> —
          the host application or its user decides which resources to include in
          the model's context. They are designed to provide the AI with the
          information it needs to reason effectively.
        </motion.p>

        <AnalogyCallout>
          Resources are like reference documents on your desk. You (the
          application) decide which files, schemas, or data to pull out and put
          in front of the AI. The AI reads them but doesn't choose which ones
          appear.
        </AnalogyCallout>

        <KeyDetails
          items={[
            "Resources are application-controlled: the host decides what context to attach, not the model.",
            "Each resource is identified by a unique URI (e.g., file:///logs/app.log, postgres://db/schema).",
            "Resources can contain text (UTF-8 strings) or binary data (base64-encoded).",
            "Common examples: file contents, database schemas, API responses, live system data, screenshots.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: Discovery — Listing and Templates */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={2}
        title="Discovery: Listing and Templates"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Servers offer two discovery mechanisms.{" "}
          <strong>Direct resources</strong> are concrete items listed via{" "}
          <code>resources/list</code> — each has a fixed URI and can be read
          immediately. <strong>Resource templates</strong>, listed via{" "}
          <code>resources/templates/list</code>, describe parameterized URIs
          using RFC 6570 syntax (e.g.,{" "}
          <code>{"users://{user_id}/profile"}</code>). Templates let clients
          construct URIs dynamically, enabling access to large or unbounded
          collections of data without listing every possible resource upfront.
        </motion.p>

        <KeyDetails
          items={[
            "resources/list: returns concrete resources the server currently exposes, each with a URI, name, and optional description and MIME type.",
            "resources/templates/list: returns URI templates with parameters, like file:///{path} or db:///{table}/{id}.",
            "Templates use RFC 6570 URI Template syntax for parameter substitution.",
            "Both endpoints support pagination via cursors for servers with many items.",
            "Servers can emit notifications/resources/list_changed when available resources change.",
          ]}
        />

        <Tip>
          Use direct resources for well-known, stable data (e.g., a system
          configuration file). Use templates for dynamic collections where the
          set of valid URIs is large or changes frequently (e.g., user profiles,
          database rows).
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: Reading Resources */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={3}
        title="Reading Resources"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Clients read resources by sending a <code>resources/read</code>{" "}
          request with the resource URI. The server returns the resource's
          contents — either text (returned as a UTF-8 string) or binary data
          (returned as base64-encoded bytes with a MIME type). A single read can
          return multiple content items, allowing a resource to bundle related
          data together.
        </motion.p>

        <KeyDetails
          items={[
            "Text resources: returned as { uri, mimeType, text } — ideal for source code, logs, JSON, Markdown.",
            "Binary resources: returned as { uri, mimeType, blob } with base64-encoded data — for images, PDFs, audio.",
            "A server must return at least one content item per read request.",
            "The URI in the response may differ from the request URI (e.g., after following a redirect or resolving a template).",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 4: URI Schemes and Subscriptions */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={4}
        title="URI Schemes and Subscriptions"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          MCP does not mandate specific URI schemes — servers can use any scheme
          that makes sense for their domain. The protocol also supports{" "}
          <strong>subscriptions</strong>, where the client can subscribe to
          change notifications for specific resources and receive real-time
          updates when the underlying data changes.
        </motion.p>

        <KeyDetails
          items={[
            "Common URI schemes: https:// (web APIs), file:// (local files), git:// (repositories), postgres:// (databases).",
            "Servers can define custom schemes like myapp://settings or project://build-config.",
            "Subscriptions: clients call resources/subscribe with a URI to get notified when that resource changes.",
            "When a subscribed resource changes, the server sends notifications/resources/updated.",
            "Clients can call resources/unsubscribe to stop receiving updates.",
          ]}
        />

        <AnalogyCallout>
          URI schemes are like file extensions for data sources. Just as{" "}
          <code>.json</code> tells you the format, the scheme{" "}
          <code>postgres://</code> tells the client where the data lives. MCP
          doesn't care about the scheme — it just passes URIs through.
        </AnalogyCallout>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 5: Resources vs. Tools */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={5}
        title="Resources vs. Tools"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          A common question: when should you expose something as a resource
          versus a tool? The answer depends on control and purpose. Resources
          are for providing context data — they load information the model needs
          to reason. Tools are for performing actions — they execute operations
          with side effects.
        </motion.p>

        <KeyDetails
          items={[
            "Use resources when: loading data into context, providing reference information, sharing file or database contents.",
            "Use tools when: the operation has side effects, modifies state, or requires model-driven decision-making.",
            "Resources are read by the application to build context. Tools are called by the model to take action.",
            "Example: a database schema is a resource (context). Running a query is a tool (action).",
          ]}
        />

        <Tip>
          If you find yourself creating a tool that just returns data with no
          side effects, consider making it a resource instead. Resources give
          the host application more control over when and how data enters the
          model's context.
        </Tip>
      </Section>

      {/* Outro */}
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
