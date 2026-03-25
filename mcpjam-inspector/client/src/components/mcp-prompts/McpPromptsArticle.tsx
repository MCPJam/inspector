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
        subtitle="Prompts are user-controlled reusable templates that define structured interactions with AI models. Learn how servers expose prompts, how arguments customize them, and how they surface as slash commands in host applications."
      />

      {/* Section 1: What Are Prompts? */}
      <Section step={1} title="What Are Prompts?">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Prompts are the third MCP server primitive, alongside tools and
          resources. They represent reusable message templates that servers can
          expose for users to select. The key distinction: prompts are{" "}
          <strong>user-controlled</strong>. Unlike tools (where the model
          decides when to call them) or resources (where the application decides
          what to include), prompts are explicitly chosen by the user — like
          pre-written scripts for a meeting. The user picks the script, and the
          template structures the conversation.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Prompts are user-controlled: the user selects which prompt to use,
            not the model or the application.
          </li>
          <li>
            Each prompt has a name, optional description, and optional arguments
            for customization.
          </li>
          <li>
            Prompts return an array of PromptMessages with role (user or
            assistant) and content.
          </li>
          <li>
            Host applications typically expose prompts as slash commands or menu
            items in the UI.
          </li>
        </ul>
      </Section>

      {/* Section 2: Discovery and Retrieval */}
      <Section step={2} title="Discovery and Retrieval">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Like tools and resources, prompts follow MCP's discover-then-use
          pattern. Clients call <code>prompts/list</code> to get available
          prompt definitions. When a user selects a prompt, the client calls{" "}
          <code>prompts/get</code> with the prompt name and any required
          arguments. The server returns an array of structured messages ready to
          be inserted into the conversation.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Discovery: <code>prompts/list</code> returns all available prompts
            with their names, descriptions, and argument schemas.
          </li>
          <li>
            Retrieval: <code>prompts/get</code> with {"{ name, arguments }"}{" "}
            returns the fully resolved prompt messages.
          </li>
          <li>
            Arguments are key-value string pairs that customize the prompt's
            content (e.g., {"{ language: 'python' }"}).
          </li>
          <li>
            Pagination: <code>prompts/list</code> supports cursors for servers
            with many prompts.
          </li>
          <li>
            Dynamic updates: servers can emit{" "}
            <code>notifications/prompts/list_changed</code> when prompts are
            added or removed.
          </li>
        </ul>
      </Section>

      {/* Section 3: Message Types and Content */}
      <Section step={3} title="Message Types and Content">
        <p className="text-sm text-muted-foreground leading-relaxed">
          A prompt's <code>get</code> response returns a structured description
          and an array of messages. Each message has a role (<code>user</code>{" "}
          or <code>assistant</code>) and content that can include multiple types
          — not just text. This allows prompts to inject rich, multi-modal
          context into a conversation.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Text content: plain text messages that set up the conversation
            context or provide instructions.
          </li>
          <li>
            Image content: base64-encoded images that give the model visual
            context (e.g., a screenshot to review).
          </li>
          <li>Audio content: base64-encoded audio for voice-related tasks.</li>
          <li>
            Embedded resources: references to MCP resources by URI, pulling live
            data directly into the prompt.
          </li>
          <li>
            Multi-message prompts: a prompt can return multiple messages to
            simulate a conversation prefix or provide examples.
          </li>
        </ul>

        <Aside>
          Embedded resources in prompts are powerful — a code review prompt can
          reference the actual file content via a resource URI, ensuring the
          model always sees the latest version of the file.
        </Aside>
      </Section>

      {/* Section 4: Arguments and Auto-Complete */}
      <Section step={4} title="Arguments and Auto-Complete">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Prompt arguments let users customize templates without editing them.
          Each argument has a name, optional description, and a{" "}
          <code>required</code> flag. The MCP protocol also supports
          auto-completion for argument values — the client can request
          suggestions from the server as the user types, providing a smooth,
          guided experience.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Arguments are defined with name, description, and required fields in
            the prompt's definition.
          </li>
          <li>
            All argument values are strings, keeping the interface simple and
            predictable.
          </li>
          <li>
            Auto-completion: clients can call <code>completion/complete</code>{" "}
            to get suggested values for an argument.
          </li>
          <li>
            Example: a "deploy" prompt might have a required "environment"
            argument with auto-complete suggestions of "staging", "production".
          </li>
        </ul>

        <Aside>
          Arguments turn a fixed template into a flexible form. Instead of
          creating separate prompts for "review Python code" and "review
          TypeScript code", you create one "review code" prompt with a
          "language" argument.
        </Aside>
      </Section>

      {/* Section 5: The Three Primitives Together */}
      <Section step={5} title="The Three Primitives Together">
        <p className="text-sm text-muted-foreground leading-relaxed">
          Tools, resources, and prompts form a complete system of three
          complementary primitives, each controlled by a different party. Tools
          give the model the ability to act. Resources give the application the
          ability to provide context. Prompts give the user the ability to
          structure interactions. Understanding who controls each primitive is
          the key to designing effective MCP servers.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
          <li>
            Tools are model-controlled: the AI decides when to invoke them to
            perform actions.
          </li>
          <li>
            Resources are application-controlled: the host decides what data to
            include as context.
          </li>
          <li>
            Prompts are user-controlled: the human selects which template to
            use.
          </li>
          <li>
            A well-designed MCP server often uses all three: tools for actions,
            resources for data, and prompts for guided workflows.
          </li>
          <li>
            Example: a GitHub MCP server exposes tools (create PR), resources
            (repo contents), and prompts (code review template).
          </li>
        </ul>

        <Aside>
          When building an MCP server, start by mapping your domain into these
          three buckets. Actions become tools. Data becomes resources. Workflows
          become prompts. The control model (who decides) guides where each
          capability belongs.
        </Aside>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP Tools</span>{" "}
        (model-controlled actions) and{" "}
        <span className="font-medium text-foreground/70">MCP Resources</span>{" "}
        (application-controlled data).
      </ArticleOutro>
    </div>
  );
}
