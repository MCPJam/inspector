import {
  Aside,
  Section,
  ArticleHero,
  ArticleOutro,
} from "@/components/learning-article/article-primitives";
import { WhyMcpConnectedDiagram } from "./WhyMcpConnectedDiagram";
import { WhyMcpGovernanceDiagram } from "./WhyMcpGovernanceDiagram";
import { WhyMcpNxMDiagram } from "./WhyMcpNxMDiagram";
import { WhyMcpProblemDiagram } from "./WhyMcpProblemDiagram";
import { WhyMcpToolCallingDiagram } from "./WhyMcpToolCallingDiagram";

export function WhyMcpArticle() {
  return (
    <div className="mx-auto max-w-2xl px-8 pb-16">
      <ArticleHero
        title="Why We Need MCP"
        subtitle="MCP gives AI a standard way to use real tools and data."
      />

      <Section step={1} title="Smart, But Stuck">
        <p className="text-base text-muted-foreground leading-relaxed">
          A model can explain how to check a database or create a Jira ticket,
          but by itself it cannot actually do those things. It can think, but
          it needs a connection to the outside world.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>Plain chat models only return text.</li>
          <li>They need tools to read data and take actions.</li>
          <li>That gap is why AI apps need integration layers.</li>
        </ul>

        <div className="space-y-2">
          <WhyMcpProblemDiagram />
          <p className="text-center text-sm text-muted-foreground/80 leading-relaxed">
            The model can talk about systems, but it cannot reach them yet.
          </p>
        </div>
      </Section>

      <Section step={2} title="Tool Calling Helps">
        <p className="text-base text-muted-foreground leading-relaxed">
          Tool calling lets the model ask for a real action, like running a
          search or looking up a file. Your app executes the action and sends
          the result back.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>You tell the model which tools exist and what inputs they take.</li>
          <li>The model chooses a tool when it needs one.</li>
          <li>The app runs the tool and returns the output.</li>
        </ul>

        <div className="space-y-2">
          <WhyMcpToolCallingDiagram />
        </div>

        <Aside>
          This is the basic idea behind agents: a model that can choose tools
          and use them to finish a task.
        </Aside>
      </Section>

      <Section step={3} title="Safety Still Matters">
        <p className="text-base text-muted-foreground leading-relaxed">
          Once an agent can do things, you need guardrails. You need to know
          what it can access, who it is acting for, and what it already did.
        </p>

        <div className="space-y-2">
          <WhyMcpGovernanceDiagram />
          <p className="text-center text-sm text-muted-foreground/80 leading-relaxed">
            Good systems limit access, log actions, and let you revoke them.
          </p>
        </div>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>Give the agent only the access it needs.</li>
          <li>Keep actions tied to the right user or tenant.</li>
          <li>Log what happened so you can review it later.</li>
        </ul>

        <Aside>
          If an agent works only for you on your laptop, the risk is lower. If
          it acts for many users, safety rules are not optional.
        </Aside>
      </Section>

      <Section step={4} title="Custom Integrations Do Not Scale">
        <p className="text-base text-muted-foreground leading-relaxed">
          Without a shared standard, every host needs a custom integration for
          every tool. That creates a messy N x M problem.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>More hosts means more duplicate integration work.</li>
          <li>More tools means more custom adapters to maintain.</li>
          <li>The cost grows fast.</li>
        </ul>

        <div>
          <WhyMcpNxMDiagram />
        </div>
      </Section>

      <Section step={5} title="MCP Is the Shared Standard">
        <p className="text-base text-muted-foreground leading-relaxed">
          MCP is the standard that lets hosts and tool servers speak the same
          language. One host can connect to many servers, and one server can
          work in many hosts.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>MCP turns many custom integrations into one shared protocol.</li>
          <li>It commonly runs over stdio for local servers or HTTP for remote ones.</li>
          <li>The main pieces are host, client, and server.</li>
        </ul>
      </Section>

      <Section step={6} title="What Servers Share">
        <p className="text-base text-muted-foreground leading-relaxed">
          MCP servers usually expose tools, resources, and prompts. Together,
          those cover actions, read-only data, and reusable workflows.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>
            <strong>Tools:</strong> actions like searching, creating, or sending.
          </li>
          <li>
            <strong>Resources:</strong> read-only data like files, docs, and schemas.
          </li>
          <li>
            <strong>Prompts:</strong> reusable templates a user can choose.
          </li>
        </ul>

        <Aside>
          The next guide, <strong>What is MCP?</strong>, shows how those pieces
          connect in one architecture.
        </Aside>
      </Section>

      <Section step={7} title="The Simple Version">
        <p className="text-base text-muted-foreground leading-relaxed">
          MCP does not replace your CLI, APIs, or prompt files. It gives AI apps
          a standard, safer way to use them.
        </p>

        <ul className="list-disc pl-5 space-y-1 text-base text-muted-foreground">
          <li>Tool calling gives AI a way to act.</li>
          <li>MCP gives apps a standard way to expose those actions and data.</li>
          <li>That makes tool integrations easier to reuse and easier to govern.</li>
        </ul>

        <div className="space-y-2">
          <WhyMcpConnectedDiagram />
          <p className="text-center text-sm text-muted-foreground/80 leading-relaxed">
            MCP is the bridge between the model and real systems.
          </p>
        </div>

        <p className="text-base text-foreground/70 leading-relaxed font-medium italic">
          The hard part was never just model intelligence. It was safe access to
          real tools and data.
        </p>
      </Section>

      <ArticleOutro>
        Next up: open{" "}
        <span className="font-medium text-foreground/70">What is MCP?</span>{" "}
        to see the architecture one piece at a time.
      </ArticleOutro>
    </div>
  );
}
