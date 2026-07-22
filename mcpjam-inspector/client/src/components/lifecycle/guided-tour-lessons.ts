import {
  Cable,
  FlaskConical,
  Gamepad2,
  Package,
  Users,
} from "lucide-react";
import type { GuidedTourConcept, LearningGroup } from "./learning-concepts";

/**
 * Guided tours. Unlike the reading modules, selecting one of these does not
 * open an in-tab article — it launches the MCPJam agent in the side panel,
 * seeded with the tour's `agentPrompt` as the user's first message. The agent
 * then teaches by driving the real inspector UI (navigate, narrate, prefill
 * forms) through the existing `ui_*` tool catalog, handing the final,
 * consequential click back to the user.
 *
 * The teaching quality lives entirely in these prompts. They are natural
 * language and deliberately do NOT name `ui_*` tools — the agent already knows
 * its catalog; hard-coding tool names would rot as the catalog changes and
 * fight the model's own planning. Each prompt = a goal + a numbered walk +
 * TOUR_GROUND_RULES.
 */

/**
 * Appended to every tour prompt. Encodes the safety and pedagogy invariants the
 * agent must hold regardless of which tour is running: narrate before acting,
 * adapt to the user's real state, prefill but never submit, never spend
 * money/quota without asking, and close by pointing the user back to mark the
 * tour complete.
 */
const TOUR_GROUND_RULES = `
Ground rules for this tour — follow all of them:
1. Before you act on any screen, explain in 1-2 sentences what that screen or control is for. Keep narration short; this is a tour, not a lecture.
2. Start by taking a snapshot of the app so the tour matches my real state. If something you need is already set up, say so and skip ahead instead of redoing it.
3. If the tour needs a connected MCP server and I don't have one, detour first: help me connect one (a public demo server is fine), then continue.
4. Prefill any forms for me and explain each field, but never click the final submit / create / run button yourself — hand that click back to me and tell me exactly what to press.
5. Never start anything that spends money, tokens, or run quota (model calls, eval runs, swarm runs) without asking me first.
6. Move one step at a time and check in briefly so I can follow along.
7. When we're done, recap what I learned in 2-3 bullets and remind me to go back to the Learning tab and check this tour off as complete.
`.trim();

function withGroundRules(body: string): string {
  return `${body.trim()}\n\n${TOUR_GROUND_RULES}`;
}

export const GUIDED_TOURS: GuidedTourConcept[] = [
  {
    kind: "guided",
    id: "tour-connect-server",
    title: "Connect your first MCP server",
    description:
      "The agent walks you through adding a server and seeing its tools.",
    icon: Cable,
    category: "Guided tour",
    estimatedMinutes: 3,
    agentPrompt: withGroundRules(`
Give me a hands-on guided tour of connecting my first MCP server in the MCPJam inspector (about 3 minutes). I'm brand new — assume I've never connected one.

Walk me through, in order:
1. In a sentence, what an MCP server connection is and why I'd add one here.
2. Take a snapshot to see whether I already have a server connected. If I do, point it out and offer to show me its tools instead of adding another.
3. Open the form to add a new server and explain the transport choice — a remote HTTP URL versus a local command (STDIO) — so I know which to pick.
4. Prefill the form with a reputable public demo MCP server over HTTP so I can try it without any setup. Explain what each field is.
5. Stop and hand me the Connect button — tell me exactly what to click.
6. Once it's connected, show me where the server's tools (and resources, if any) appear, so I know the connection worked.
`),
  },
  {
    kind: "guided",
    id: "tour-playground-tool",
    title: "Run a tool in the Playground",
    description:
      "Chat with a model and watch it call one of your server's tools.",
    icon: Gamepad2,
    category: "Guided tour",
    estimatedMinutes: 4,
    agentPrompt: withGroundRules(`
Give me a hands-on guided tour of the Playground in the MCPJam inspector (about 4 minutes). I want to see a model actually call one of my MCP server's tools.

Walk me through, in order:
1. In a sentence or two, what the Playground is — a chat where a model can use my connected server's tools.
2. Snapshot my state. I need a connected server with at least one tool; if I don't have one, detour and help me connect one first.
3. Take me to the Playground and explain what I'm looking at.
4. Explain the model picker and that every message sends a real, billable model call. Help me pick an inexpensive model.
5. Draft a chat message that should make the model call a specific tool my server exposes, and tell me which tool you expect it to use and why.
6. Stop before sending — ask me to hit send myself (this spends a model call).
7. After it runs, walk me through the result: where the tool call shows up, the arguments the model chose, and what the tool returned.
`),
  },
  {
    kind: "guided",
    id: "tour-eval-suite",
    title: "Create and run an eval suite",
    description:
      "Build a test suite for your server's tools and score a run.",
    icon: FlaskConical,
    category: "Guided tour",
    estimatedMinutes: 5,
    agentPrompt: withGroundRules(`
Give me a hands-on guided tour of evals in the MCPJam inspector (about 5 minutes). I want to learn how to create an eval suite for an MCP server and run it.

Walk me through, in order:
1. In a couple of sentences, what evals are for in MCPJam — testing that a model uses my MCP server's tools correctly.
2. Check my current state. I need a connected MCP server to eval against; if I don't have one, help me connect one first.
3. Take me to the evals area and explain what I'm looking at.
4. Open the create-suite dialog and prefill the suite name for me. The test prompts and expected tool calls are mine to fill in — walk me through a good first test case based on the tools my server actually exposes (a prompt a real user might ask, and the tool you'd expect the model to call), and explain how expected tool calls are judged.
5. If there's a way to generate test cases automatically, mention it and what it costs before suggesting it.
6. Stop before running anything. Tell me exactly which button to press to save and run the suite, warn me that running it calls a real model, and let me decide.
7. If I choose to run it, explain how to read the results — what a pass and a fail look like, and what I'd change to fix a failing test.
`),
  },
  {
    kind: "guided",
    id: "tour-swarms",
    title: "Simulate users with Swarms",
    description:
      "Create a persona and a journey to stress-test your server.",
    icon: Users,
    category: "Guided tour",
    estimatedMinutes: 5,
    agentPrompt: withGroundRules(`
Give me a hands-on guided tour of Swarms in the MCPJam inspector (about 5 minutes). I want to simulate real users exercising my MCP server.

Walk me through, in order:
1. In a couple of sentences, what Swarms are — synthetic user personas that run through journeys against my server — and why that's useful.
2. Snapshot my state. Swarms need a connected server; if I don't have one, detour and help me connect one first.
3. Take me to Swarms and explain the pieces: personas and journeys.
4. Explain what a persona is and suggest a good starter persona for my server — a name, a role, and a note or two. Creating it is a quick form; tell me exactly what to enter rather than creating it for me.
5. Explain what a journey is, then open the new-journey form and prefill the goal text for a task this persona would plausibly attempt with my server's tools. Picking the host and how many sessions is mine to choose — walk me through those.
6. Explain that launching a swarm run consumes run quota and model calls. Stop before launching — hand me the launch button and let me decide.
`),
  },
  {
    kind: "guided",
    id: "tour-hosts",
    title: "Package servers into a Host",
    description:
      "Bundle your connected servers into a named, reusable Host.",
    icon: Package,
    category: "Guided tour",
    estimatedMinutes: 4,
    agentPrompt: withGroundRules(`
Give me a hands-on guided tour of Hosts in the MCPJam inspector (about 4 minutes). I want to package my servers into a reusable Host.

Walk me through, in order:
1. In a couple of sentences, what a Host is — a named bundle of MCP servers exposed together to a client — and when I'd want one.
2. Snapshot my state so we can use my actual connected server(s). If I have none, detour and help me connect one first.
3. Take me to Hosts and explain what I'm looking at.
4. Walk me through creating a host: suggest a clear name and tell me exactly what to click to create it (creating the host, and later attaching servers, are commits I'll make myself — describe the values to use rather than doing it for me).
5. Once the host exists, open its editor and show me where I'd adjust its config — model, system prompt, and behavior. Then explain that servers are selected project-wide (not inside this editor): take me to the Servers tab and show me how to include my connected server(s) so the host can use them.
6. Recap what the Host lets me do and what I'd change next.
`),
  },
];

export const GUIDED_TOURS_GROUP: LearningGroup = {
  title: "Guided tours",
  subtitle: "Hands-on tours where the MCPJam agent drives the app with you",
  modules: GUIDED_TOURS,
};
