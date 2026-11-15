import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  FeatureSpotlight,
  FeatureSpotlightActions,
  FeatureSpotlightAnchor,
  FeatureSpotlightClose,
  FeatureSpotlightContent,
  FeatureSpotlightDescription,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";

/**
 * FeatureSpotlight stories. When to use it is on the Overview page
 * (FeatureSpotlight.mdx). The Conformance intro in the sidebar is the first
 * user; its CTA options are laid out below.
 */
const meta = {
  title: "Components/Feature Spotlight",
  component: FeatureSpotlight,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeatureSpotlight>;

export default meta;
type Story = StoryObj<typeof meta>;

function SidebarRow() {
  return (
    <div className="flex w-56 items-center gap-2 rounded-md border border-border bg-sidebar px-2 py-1.5 text-sm text-sidebar-foreground">
      <CircleCheck className="size-4" aria-hidden />
      <span>Conformance</span>
    </div>
  );
}

function Spotlit({
  caption,
  children,
}: {
  caption: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-72 flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground">{caption}</p>
      <FeatureSpotlight open>
        <FeatureSpotlightAnchor className="w-fit">
          <SidebarRow />
        </FeatureSpotlightAnchor>
        <FeatureSpotlightContent>{children}</FeatureSpotlightContent>
      </FeatureSpotlight>
    </div>
  );
}

function ConformanceCopy() {
  return (
    <>
      <Badge>New</Badge>
      <FeatureSpotlightTitle>
        Check your server against the MCP spec
      </FeatureSpotlightTitle>
      <FeatureSpotlightDescription>
        Conformance runs the spec's Protocol, Apps, Tasks and OAuth checks on
        your server and explains every failure in plain language. Fix them
        before Claude or ChatGPT users run into them.
      </FeatureSpotlightDescription>
    </>
  );
}

/** What ships: run the user's server, or dismiss. */
export const WithServer: Story = {
  render: () => (
    <div className="p-8">
      <Spotlit caption="The user has a server: the primary starts a run on it.">
        <ConformanceCopy />
        <FeatureSpotlightActions>
          <Button size="sm">Check excalidraw</Button>
          <Button size="sm" variant="ghost">
            Got it
          </Button>
        </FeatureSpotlightActions>
      </Spotlit>
    </div>
  ),
};

/** No server yet: the primary opens the page, where they can add one. */
export const NoServer: Story = {
  render: () => (
    <div className="p-8">
      <Spotlit caption="No server: the primary opens Conformance.">
        <ConformanceCopy />
        <FeatureSpotlightActions>
          <Button size="sm">Open Conformance</Button>
          <Button size="sm" variant="ghost">
            Got it
          </Button>
        </FeatureSpotlightActions>
      </Spotlit>
    </div>
  ),
};

/**
 * Other CTA shapes considered. A is what ships: one action that does the
 * thing, one quiet way out. B suits a server picker but adds a decision before
 * any value. C fits a callout with no obvious next step.
 */
export const CtaOptions: Story = {
  render: () => (
    <div className="flex flex-col gap-8 p-8">
      <Spotlit caption="A. Run now + Got it (ships)">
        <ConformanceCopy />
        <FeatureSpotlightActions>
          <Button size="sm">Check excalidraw</Button>
          <Button size="sm" variant="ghost">
            Got it
          </Button>
        </FeatureSpotlightActions>
      </Spotlit>
      <Spotlit caption="B. Choose a server + Not now">
        <ConformanceCopy />
        <FeatureSpotlightActions>
          <Button size="sm">Choose a server</Button>
          <Button size="sm" variant="ghost">
            Not now
          </Button>
        </FeatureSpotlightActions>
      </Spotlit>
      <Spotlit caption="C. Single action + corner close">
        <FeatureSpotlightClose />
        <ConformanceCopy />
        <FeatureSpotlightActions>
          <Button size="sm" variant="outline">
            Open Conformance
          </Button>
        </FeatureSpotlightActions>
      </Spotlit>
    </div>
  ),
};
