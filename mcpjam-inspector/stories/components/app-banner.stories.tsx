import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { AppBanner } from "@mcpjam/design-system/app-banner";
import { Button } from "@mcpjam/design-system/button";
import { ThemePair } from "../_support/theme-pair";

/**
 * App banner stories. When to use it is on the Overview page (AppBanner.mdx).
 * Each specimen sits on a stand-in for the app chrome so the left alignment
 * and right-edge action read the way they do in the product.
 */
const meta = {
  title: "Components/App banner",
  component: AppBanner,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-40 flex-col overflow-hidden rounded-lg border border-border bg-sidebar">
      {children}
      <div className="flex h-10 items-center border-b border-border/60 px-4 text-sm font-medium">
        Servers
      </div>
      <div className="m-2 flex-1 rounded-md border border-border/60 bg-background" />
    </div>
  );
}

const updateCard = (
  <Button size="sm" variant="outline">
    Update card
  </Button>
);

export const Prominent: Story = {
  args: {
    children: (
      <>
        <span className="font-medium">Payment failed for Acme Labs.</span>{" "}
        Update your card by Dec 11, 2026 to keep Team.
      </>
    ),
    actions: updateCard,
  },
  render: (args) => (
    <div className="p-6">
      <Chrome>
        <AppBanner {...args} />
      </Chrome>
    </div>
  ),
};

export const Quiet: Story = {
  args: {
    emphasis: "quiet",
    children:
      "Payment failed for Acme Labs. An owner has been asked to update the card.",
    onDismiss: () => {},
  },
  render: Prominent.render,
};

export const Neutral: Story = {
  args: {
    tone: "neutral",
    children: "Couldn't update your session.",
    actions: (
      <>
        <Button size="sm" variant="outline">
          Retry
        </Button>
        <Button size="sm" variant="outline">
          Sign in
        </Button>
      </>
    ),
  },
  render: Prominent.render,
};

export const LightAndDark: Story = {
  args: { children: null },
  globals: { theme: "light" },
  render: () => (
    <ThemePair>
      <Chrome>
        <AppBanner actions={updateCard}>
          <span className="font-medium">Payment failed for Acme Labs.</span>{" "}
          Update your card by Dec 11, 2026 to keep Team.
        </AppBanner>
      </Chrome>
      <Chrome>
        <AppBanner emphasis="quiet" onDismiss={() => {}}>
          Payment failed for Acme Labs. An owner has been asked to update the
          card.
        </AppBanner>
      </Chrome>
      <Chrome>
        <AppBanner
          tone="neutral"
          actions={
            <Button size="sm" variant="outline">
              Retry
            </Button>
          }
        >
          Couldn't update your session.
        </AppBanner>
      </Chrome>
    </ThemePair>
  ),
};
