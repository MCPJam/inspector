import type { Meta, StoryObj } from "@storybook/react-vite";
import { CandidateRow } from "@/components/evals/evaluator-library/candidate-row";
import { CodeEvaluatorPanel } from "@/components/evals/evaluator-library/code-evaluator-panel";
import { OwaspCoverageCell } from "@/components/evals/evaluator-library/owasp-coverage-cell";
import { ProbeRow } from "@/components/evals/evaluator-library/probe-row";
import { SpecKeyword } from "@/components/evals/evaluator-library/spec-keyword";
import { Grid, Specimen } from "./_frame";

/** Server checks, find-then-confirm candidates and the code evaluator. */
const meta = {
  title: "Evaluator Library/4 Server checks and code",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Probes: Story = {
  render: () => (
    <div className="flex max-w-5xl flex-col gap-3 p-2">
      <div className="flex gap-2">
        <SpecKeyword keyword="MUST" />
        <SpecKeyword keyword="MUST NOT" />
        <SpecKeyword keyword="SHOULD" />
        <SpecKeyword keyword="MAY" />
      </div>
      <ProbeRow
        name="Token Audience Check"
        attack="Token passthrough"
        owasp="MCP07"
        requirement={{
          keyword: "MUST NOT",
          text: "accept tokens not issued for this server",
        }}
        method="Sends a valid token issued for a different resource."
        result="failed"
        resultDetail="200 OK, 14 tools listed"
        defaultOpen
        steps={[
          { label: "Get a token for api.other.example", passed: true },
          {
            label: "Call initialize with it",
            detail: "Expected 401, got 200",
            passed: false,
          },
        ]}
        fix="Reject the request unless the token's aud claim is this server's URI."
        reproduce={
          'curl -i https://mcp.example.dev/mcp \\\n  -H "Authorization: Bearer $OTHER_TOKEN"'
        }
        onRerun={() => {}}
        onAcceptRisk={() => {}}
      />
      <ProbeRow
        name="Session Binding"
        attack="Session hijacking"
        requirement={{
          keyword: "MUST",
          text: "bind session IDs to the authorized user",
        }}
        method="Replays a session ID from a second user."
        result="passed"
        steps={[{ label: "Replay from user B", passed: true }]}
      />
      <ProbeRow
        name="Per-client Consent"
        attack="Confused deputy"
        requirement={{ text: "Only applies to OAuth proxy servers" }}
        method="Registers two clients against one upstream."
        result="not_applicable"
      />
    </div>
  ),
};

export const Coverage: Story = {
  render: () => (
    <div className="grid max-w-4xl grid-cols-2 gap-3 p-2 lg:grid-cols-4">
      <OwaspCoverageCell
        id="MCP06"
        title="Prompt injection via tool results"
        coveredBy="Ignores Injected Instructions"
        coverage="failing"
      />
      <OwaspCoverageCell
        id="MCP07"
        title="Token mismanagement"
        coveredBy="Token Audience Check"
        coverage="partial"
      />
      <OwaspCoverageCell
        id="MCP01"
        title="Secret exposure"
        coveredBy="No Secrets in Output"
        coverage="passing"
      />
      <OwaspCoverageCell
        id="MCP04"
        title="Supply chain and dependency tampering"
        coveredBy="Outside MCPJam"
        coverage="not_covered"
      />
    </div>
  ),
};

export const Candidates: Story = {
  render: () => (
    <Grid>
      <Specimen label="find then confirm" width={480}>
        <div className="flex flex-col gap-2">
          <CandidateRow
            kind="Stripe secret key"
            value="sk_live_51HxQmPa9fK2Qm2a"
            location="get_order result · payment.processor_key"
            verdict="confirmed"
            probability={0.97}
          />
          <CandidateRow
            kind="Email address"
            value="test@example.com"
            location="get_order result · contact"
            verdict="dismissed"
            probability={0.08}
          />
          <CandidateRow
            kind="Phone number"
            value="+1 555 0100"
            location="final answer"
            verdict="allowed"
          />
        </div>
      </Specimen>
    </Grid>
  ),
};

const code = `import type { EvaluatorContextV1 } from "@mcpjam/evaluators";

export default {
  id: "quoted-cart-total-matches",
  evaluate(context: EvaluatorContextV1) {
    const total = context.transcript.toolResults.at(-1).cart_total;
    const quoted = context.transcript.finalText.includes(String(total));
    return {
      kind: "scored",
      score: quoted ? 1 : 0,
      explanation: \`cart_total is $\${total}\`,
    };
  },
};`;

export const CodeEvaluator: Story = {
  render: () => (
    <Grid>
      <Specimen label="error on a test iteration" width={720}>
        <CodeEvaluatorPanel
          fileName="quoted-cart-total.ts"
          code={code}
          errorLine={6}
          consoleOutput={
            "TypeError: Cannot read properties of undefined (reading 'cart_total')\n    at evaluate (quoted-cart-total.ts:6:58)"
          }
          onRunTests={() => {}}
        />
      </Specimen>
      <Specimen label="synced from GitHub" width={720}>
        <CodeEvaluatorPanel
          fileName="quoted-cart-total.ts"
          code={code}
          source="github"
        />
      </Specimen>
    </Grid>
  ),
};
