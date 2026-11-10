import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { FieldError } from "@mcpjam/design-system/field-error";
import { BeforeAfter, Panel, SurfaceFrame } from "./_support/layout";
import { useToastSpecimen } from "./_support/specimens";

/**
 * PATTERN 2 — Inline, beside the control.
 *
 * The surface for "the reader's own input is wrong or missing", and the one
 * placement with a hard rule attached: validation never goes in a toast.
 *
 * The "after" column uses the real `FieldError` from the design system. That
 * component was added because there was no component for a message under a
 * form field: each is written by hand, so `role="alert"` depends on the author
 * remembering it. How many existing field messages lack it has not been
 * measured.
 */
const meta = {
  title: "Error Patterns/2. Inline validation",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "When the reader's own input is wrong or missing, the message belongs " +
          "beside the control they are looking at. A toast cannot do this job: " +
          "it appears away from the field, it leaves without being read, and it " +
          "does not mark which of six inputs to fix.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The hero example, and the reason this standard exists.
 *
 * A user tried to connect an STDIO server in the hosted app, was told "STDIO
 * servers aren't supposed in hosted mode", and then spent several minutes
 * hunting for a per-server "hosted mode" setting that does not exist. The
 * message named a mode they had not chosen, offered no way forward, and carried
 * a typo that made it read as a stray log line.
 */
export const HostedStdioServer: Story = {
  name: "Hosted mode rejects an STDIO server",
  render: function HostedStdioServerStory() {
    // The real toast, through the app's own wrapper, raised on mount so the
    // failure is visible without anyone pressing anything.
    useToastSpecimen((toast) =>
      toast.error("STDIO servers aren't supposed in hosted mode", {
        duration: Infinity,
      }),
    );

    return (
      <BeforeAfter>
        <Panel
          kind="before"
          caption="What a user actually saw in app.mcpjam.com, reported with a screen recording. Pinned open here; in the product it times out. Not quotable from this repo — the nearest string today is 'Hosted eval runs cannot spawn STDIO servers', so it either changed or comes from the hosted backend."
          provenance="reported"
broken={[
            'E1 — "STDIO", "hosted mode" and the typo ("supposed") read as a log line, not a sentence.',
            "E2 — Names a state, not a failure. It never says the command field is the thing that cannot work here.",
            "E3 — No way out. The actual fix (run the inspector locally, or use an HTTP server) is never mentioned.",
            "Placement — Sits bottom-right, away from the field that caused it, and leaves on its own.",
          ]}
        >
          <SurfaceFrame title="Add server">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cmd-before">Command</Label>
              <Input
                id="cmd-before"
                defaultValue="npx -y @modelcontextprotocol/server-filesystem /tmp"
              />
              <div className="flex justify-end pt-1">
                <Button size="sm">Connect</Button>
              </div>
            </div>
          </SurfaceFrame>
        </Panel>

        <Panel
          kind="after"
          caption="Attached to the field, naming the constraint and both ways around it. Uses the real FieldError component."
          broken={[
            "E1 — Plain words. No error code, no typo, nothing the reader did not type.",
            "E2 — Names the thing (this command) and the cause (hosted mode runs in the cloud, with no local machine to run it on).",
            "E3 — Two real ways out, one of them a link to the exact place.",
            "Placement — Beside the control, and it stays until the input changes.",
            "Announced: role=\"alert\" comes from FieldError, and aria-describedby ties it to the input.",
          ]}
        >
          <SurfaceFrame title="Add server">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cmd-after" className="text-destructive">
                Command
              </Label>
              <Input
                id="cmd-after"
                aria-invalid
                aria-describedby="cmd-after-error"
                defaultValue="npx -y @modelcontextprotocol/server-filesystem /tmp"
                className="border-destructive focus-visible:ring-destructive/20"
              />
              <FieldError id="cmd-after-error">
                Couldn&apos;t connect: the hosted app can&apos;t run a local
                command.
              </FieldError>
              <p className="text-xs text-muted-foreground">
                Hosted servers run in the cloud, so there&apos;s no machine here
                to run this on. Connect over HTTP instead, or{" "}
                <a className="underline underline-offset-2" href="#">
                  run the inspector locally
                </a>{" "}
                to use STDIO.
              </p>
              <div className="flex justify-end pt-1">
                <Button size="sm">Connect</Button>
              </div>
            </div>
          </SurfaceFrame>
        </Panel>
      </BeforeAfter>
    );
  },
};

/**
 * The same shape on a plainer case, to show the pattern is not reserved for
 * interesting errors. "Required" alone fails E2: it names no thing and no
 * consequence.
 */
export const MissingRequiredValue: Story = {
  name: "A required field is empty",
  render: () => (
    <BeforeAfter>
      <Panel
        kind="before"
        caption="Technically true, and no help. Also hand-written markup, so nothing announces it."
        provenance="illustrative"
broken={[
          'E2 — "Required" names neither the thing nor what will happen without it.',
          "E3 — No way out: nothing says what a valid value looks like.",
          'Not announced — a bare <p className="text-sm text-destructive"> with no role.',
        ]}
      >
        <SurfaceFrame title="Connection">
          <div className="flex flex-col gap-2">
            <Label htmlFor="url-before">Server URL</Label>
            <Input id="url-before" defaultValue="" />
            <p className="text-sm text-destructive">Required</p>
          </div>
        </SurfaceFrame>
      </Panel>

      <Panel
        kind="after"
        caption="Names the thing, shows the shape of a valid answer, and announces itself."
        broken={[
          "E2 — Names the field and why it is needed.",
          "E3 — The placeholder and the message together make a correct value obvious.",
          'E4 — Opens with "Couldn\'t", the one failure verb.',
          "Announced — FieldError supplies role=\"alert\" whether or not the author remembered it.",
        ]}
      >
        <SurfaceFrame title="Connection">
          <div className="flex flex-col gap-2">
            <Label htmlFor="url-after" className="text-destructive">
              Server URL
            </Label>
            <Input
              id="url-after"
              aria-invalid
              aria-describedby="url-after-error"
              defaultValue=""
              placeholder="https://example.com/mcp"
              className="border-destructive focus-visible:ring-destructive/20"
            />
            <FieldError id="url-after-error">
              Couldn&apos;t save: enter the URL this server listens on.
            </FieldError>
          </div>
        </SurfaceFrame>
      </Panel>
    </BeforeAfter>
  ),
};
