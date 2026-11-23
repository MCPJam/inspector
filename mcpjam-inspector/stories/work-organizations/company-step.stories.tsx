import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CompanyStep } from "@/components/signup/CompanyStep";
import type {
  CompanyStepActions,
  ShownCompanyStep,
} from "@/hooks/useWorkOrganizations";

/**
 * The company step after the role question (Work account consolidation, task
 * 1B), with the mock's sample data: Acme at acme.com, Jo asking to join and
 * Alex as the first signup. Rendered at 1280 × 800 for the design targets
 * 1B-1 to 1B-3. The calls are stand-ins; nothing reaches a backend.
 */
const ACME: ShownCompanyStep = {
  step: "join",
  organizationId: "org_acme",
  name: "Acme",
  domain: "acme.com",
};

const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 600));

const ACTIONS: CompanyStepActions = { ask: wait, continue: wait };

const meta = {
  title: "Work organizations/Company step",
  component: CompanyStep,
  parameters: { layout: "fullscreen" },
  args: {
    step: ACME,
    personalOrganizationName: "Jo's Org",
    email: "jo@acme.com",
    userId: "user_jo",
    actions: ACTIONS,
    onDone: () => {},
  },
} satisfies Meta<typeof CompanyStep>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1B-1: a coworker's first look at their company's Work organization. */
export const Join: Story = {};

/** 1B-2: right after Ask to join. */
export const Requested: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Ask to join" }));
    await expect(
      await canvas.findByRole("heading", {
        name: "Request sent to Acme (Work)",
      }),
    ).toBeInTheDocument();
  },
};

/** Sending the request failed. */
export const RequestFailed: Story = {
  args: {
    actions: {
      ...ACTIONS,
      ask: () => wait().then(() => Promise.reject(new Error("offline"))),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Ask to join" }));
    await expect(await canvas.findByRole("alert")).toBeInTheDocument();
  },
};

/** 1B-3: the first signup from acme.com owns its Work organization. */
export const Owner: Story = {
  args: {
    step: { ...ACME, step: "owner" },
    personalOrganizationName: "Alex's Org",
    email: "alex@acme.com",
    userId: "user_alex",
  },
};
