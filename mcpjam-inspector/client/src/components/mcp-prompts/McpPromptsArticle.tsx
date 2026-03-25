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

export function McpPromptsArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP Prompts"
        subtitle="Prompts are user-controlled reusable templates that define structured interactions with AI models. Learn how servers expose prompts, how arguments customize them, and how they surface as slash commands in host applications."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: What Are Prompts? */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={1}
        title="What Are Prompts?"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Prompts are the third MCP server primitive, alongside tools and
          resources. They represent reusable message templates that servers can
          expose for users to select. The key distinction: prompts are{" "}
          <strong>user-controlled</strong>. Unlike tools (where the model
          decides when to call them) or resources (where the application decides
          what to include), prompts are explicitly chosen by the user. They
          guide the model toward a particular mode of interaction.
        </motion.p>

        <AnalogyCallout>
          Prompts are like pre-written scripts for a meeting. The user picks the
          script ("let's do a code review"), and the template structures the
          conversation. The model follows the script but fills in the details
          with real data.
        </AnalogyCallout>

        <KeyDetails
          items={[
            "Prompts are user-controlled: the user selects which prompt to use, not the model or the application.",
            "Each prompt has a name, optional description, and optional arguments for customization.",
            "Prompts return an array of PromptMessages with role (user or assistant) and content.",
            "Host applications typically expose prompts as slash commands or menu items in the UI.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: Discovery and Retrieval */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={2}
        title="Discovery and Retrieval"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Like tools and resources, prompts follow MCP's discover-then-use
          pattern. Clients call <code>prompts/list</code> to get available
          prompt definitions. When a user selects a prompt, the client calls{" "}
          <code>prompts/get</code> with the prompt name and any required
          arguments. The server returns an array of structured messages ready to
          be inserted into the conversation.
        </motion.p>

        <KeyDetails
          items={[
            "Discovery: prompts/list returns all available prompts with their names, descriptions, and argument schemas.",
            "Retrieval: prompts/get with { name, arguments } returns the fully resolved prompt messages.",
            "Arguments are key-value string pairs that customize the prompt's content (e.g., { language: 'python' }).",
            "Pagination: prompts/list supports cursors for servers with many prompts.",
            "Dynamic updates: servers can emit notifications/prompts/list_changed when prompts are added or removed.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: Message Types and Content */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={3}
        title="Message Types and Content"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          A prompt's <code>get</code> response returns a structured description
          and an array of messages. Each message has a role (<code>user</code>{" "}
          or <code>assistant</code>) and content that can include multiple types
          — not just text. This allows prompts to inject rich, multi-modal
          context into a conversation.
        </motion.p>

        <KeyDetails
          items={[
            "Text content: plain text messages that set up the conversation context or provide instructions.",
            "Image content: base64-encoded images that give the model visual context (e.g., a screenshot to review).",
            "Audio content: base64-encoded audio for voice-related tasks.",
            "Embedded resources: references to MCP resources by URI, pulling live data directly into the prompt.",
            "Multi-message prompts: a prompt can return multiple messages to simulate a conversation prefix or provide examples.",
          ]}
        />

        <Tip>
          Embedded resources in prompts are powerful — a code review prompt can
          reference the actual file content via a resource URI, ensuring the
          model always sees the latest version of the file.
        </Tip>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 4: Arguments and Auto-Complete */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={4}
        title="Arguments and Auto-Complete"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Prompt arguments let users customize templates without editing them.
          Each argument has a name, optional description, and a{" "}
          <code>required</code> flag. The MCP protocol also supports
          auto-completion for argument values — the client can request
          suggestions from the server as the user types, providing a smooth,
          guided experience.
        </motion.p>

        <KeyDetails
          items={[
            "Arguments are defined with name, description, and required fields in the prompt's definition.",
            "All argument values are strings, keeping the interface simple and predictable.",
            "Auto-completion: clients can call completion/complete to get suggested values for an argument.",
            "Example: a 'deploy' prompt might have a required 'environment' argument with auto-complete suggestions of 'staging', 'production'.",
          ]}
        />

        <AnalogyCallout>
          Arguments turn a fixed template into a flexible form. Instead of
          creating separate prompts for "review Python code" and "review
          TypeScript code", you create one "review code" prompt with a
          "language" argument.
        </AnalogyCallout>
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 5: The Three Primitives Together */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="protocol"
        categoryColor={COLOR}
        step={5}
        title="The Three Primitives Together"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Tools, resources, and prompts form a complete system of three
          complementary primitives, each controlled by a different party. Tools
          give the model the ability to act. Resources give the application the
          ability to provide context. Prompts give the user the ability to
          structure interactions. Understanding who controls each primitive is
          the key to designing effective MCP servers.
        </motion.p>

        <KeyDetails
          items={[
            "Tools are model-controlled: the AI decides when to invoke them to perform actions.",
            "Resources are application-controlled: the host decides what data to include as context.",
            "Prompts are user-controlled: the human selects which template to use.",
            "A well-designed MCP server often uses all three: tools for actions, resources for data, and prompts for guided workflows.",
            "Example: a GitHub MCP server exposes tools (create PR), resources (repo contents), and prompts (code review template).",
          ]}
        />

        <Tip>
          When building an MCP server, start by mapping your domain into these
          three buckets. Actions become tools. Data becomes resources. Workflows
          become prompts. The control model (who decides) guides where each
          capability belongs.
        </Tip>
      </Section>

      {/* Outro */}
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
