import { motion } from "framer-motion";
import {
  sectionChild,
  KeyDetails,
  Tip,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { ComparisonTable } from "@/components/learning-article/ComparisonTable";

// ---------------------------------------------------------------------------
// Category accent
// ---------------------------------------------------------------------------

const COLOR = "#10b981"; // emerald

// ---------------------------------------------------------------------------
// Article content
// ---------------------------------------------------------------------------

export function McpVsCliArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="MCP vs CLI"
        subtitle="CLI tools are the engineer's Swiss army knife. Understand when speed and simplicity win, when governance and multi-user safety matter, and how to choose between them."
      />

      {/* ----------------------------------------------------------------- */}
      {/* Section 1: The Comparison */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={1}
        title="CLI: The Engineer's Swiss Army Knife"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          CLI tools are fast, efficient, and battle-tested. For AI agents,
          wrapping CLI commands is often the simplest integration path. But the
          tradeoffs become clear as you move from single-user scripts to
          multi-user production systems.
        </motion.p>

        <ComparisonTable
          headers={["Aspect", "CLI", "MCP"]}
          rows={[
            {
              cells: [
                "Token efficiency",
                "Excellent — a ~800-token tip doc is all the agent needs",
                "Higher overhead — full tool schemas injected per conversation",
              ],
            },
            {
              cells: [
                "Reliability",
                "~100% success rate",
                "Can face timeout issues without proper infrastructure",
              ],
            },
            {
              cells: [
                "Authentication",
                "Ambient credentials (your shell session)",
                "Per-user OAuth 2.1 with PKCE, scoped and revocable",
              ],
            },
            {
              cells: [
                "Tenant isolation",
                "None at protocol level",
                "Built-in per-user/per-tenant boundaries",
              ],
            },
            {
              cells: [
                "Audit trail",
                "Shell history (unstructured)",
                "Structured, queryable logs with user attribution",
              ],
            },
            {
              cells: [
                "Security at scale",
                "Risky — credential leakage, no isolation",
                "Protocol-level authorization and access control",
              ],
            },
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 2: When CLI Wins */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={2}
        title="When CLI Wins"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          A developer automating their own workflow. You're the only user, you
          trust the environment, and you want maximum speed and minimum cost.
          CLI wrappers give the agent exactly what it needs with near-zero
          overhead.
        </motion.p>

        <KeyDetails
          items={[
            "Single-user automation where you control the environment.",
            "Token efficiency matters — CLI tip docs are tiny compared to full MCP tool schemas.",
            "The agent is running locally in your shell session with your ambient credentials.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 3: When MCP Wins */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={3}
        title="When MCP Wins"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          Your agent acts on behalf of other users or customers. You need
          per-user auth, audit trails, and tenant isolation. A bug in CLI
          credential management could mean sending Acme's data to Globex's Jira
          — that's a data breach, not a bug.
        </motion.p>

        <KeyDetails
          items={[
            "Multi-user production systems where the agent acts on behalf of others.",
            "Per-user authorization, audit trails, and tenant isolation are requirements.",
            "Credential leakage in a shared CLI environment becomes a security incident.",
          ]}
        />
      </Section>

      {/* ----------------------------------------------------------------- */}
      {/* Section 4: The Bottom Line */}
      {/* ----------------------------------------------------------------- */}
      <Section
        category="comparison"
        categoryColor={COLOR}
        step={4}
        title="The Bottom Line"
      >
        <motion.p
          className="text-sm text-muted-foreground leading-relaxed"
          {...sectionChild(2)}
        >
          CLI and MCP aren't competing — they serve different trust models.
        </motion.p>

        <KeyDetails
          items={[
            "CLI is about efficiency for single-user automation.",
            "MCP is about governance for multi-user production systems.",
            "Many teams use both: CLI for local dev workflows, MCP for customer-facing agents.",
          ]}
        />

        <Tip>
          Start with CLI if you're the only user. Move to MCP when your agent
          starts acting on behalf of others — that's when governance stops being
          optional.
        </Tip>
      </Section>

      <ArticleOutro>
        See also:{" "}
        <span className="font-medium text-foreground/70">MCP vs REST APIs</span>{" "}
        and{" "}
        <span className="font-medium text-foreground/70">MCP vs Skills</span>{" "}
        for the full picture.
      </ArticleOutro>
    </div>
  );
}
