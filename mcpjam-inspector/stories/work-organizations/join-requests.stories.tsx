import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DecisionResult } from "@/components/access-requests/access-request-api";
import { JoinRequestRows } from "@/components/organization/JoinRequestRows";
import { OrganizationMemberRow } from "@/components/organization/OrganizationMemberRow";
import { MemberListHeader } from "@/components/settings/MemberSearch";
import type {
  OrganizationMember,
  OrganizationMembershipRole,
} from "@/hooks/useOrganizations";
import type { OrganizationAccessRequestRow } from "@/hooks/useWorkOrganizations";

/**
 * Join requests in Settings, Members & sharing (Work account consolidation,
 * task 1B), with the mock's sample data: Acme's members and Jo Chen's request.
 * Only the header count and the request rows are new; the member rows are
 * today's, drawn for context. Up to 944px wide, the list's width at 1280 × 800, for
 * the design targets 1B-4 and 1B-5. Approve and Decline resolve after a
 * moment and show their toast.
 */
const PEOPLE: Array<[string, string, OrganizationMembershipRole]> = [
  ["Sam Ortiz", "sam@acme.com", "owner"],
  ["Riley Gomez", "riley@acme.com", "admin"],
  ["Taylor Brooks", "taylor@acme.com", "member"],
  ["Dana Lee", "dana@partner.example", "guest"],
];

const MEMBERS: OrganizationMember[] = PEOPLE.map(([name, email, role]) => ({
  _id: `member_${email}`,
  organizationId: "org_acme",
  userId: `user_${email}`,
  email,
  role,
  isOwner: role === "owner",
  addedBy: "user_sam",
  addedAt: 1,
  user: { name, email, imageUrl: "" },
}));

const INVITE: OrganizationMember = {
  _id: "member_new",
  organizationId: "org_acme",
  email: "new@acme.com",
  isOwner: false,
  addedBy: "user_sam",
  addedAt: 1,
  user: null,
};

const JO: OrganizationAccessRequestRow = {
  requestId: "req_jo",
  userId: "user_jo",
  name: "Jo Chen",
  email: "jo@acme.com",
  requestedAt: Date.now(),
};

const MORGAN: OrganizationAccessRequestRow = {
  requestId: "req_morgan",
  userId: "user_morgan",
  name: "Morgan Park",
  email: "morgan@acme.com",
  requestedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
};

const decide = (_requestId: string, decision: string) =>
  new Promise<DecisionResult>((resolve) =>
    setTimeout(
      () =>
        resolve(
          decision === "approve"
            ? { status: "approved", access: "granted" }
            : { status: "declined", access: "pending" },
        ),
      800,
    ),
  );

function MembersList({
  viewer,
  requests,
}: {
  viewer: string;
  requests: OrganizationAccessRequestRow[];
}) {
  const isOwner = viewer === "sam@acme.com";
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="w-full max-w-[944px] overflow-hidden rounded-lg border border-border">
        <MemberListHeader
          activeCount={MEMBERS.length}
          pendingCount={1}
          requestCount={requests.length}
        />
        <JoinRequestRows
          requests={requests}
          organizationName="Acme"
          decide={decide}
        />
        <div className="space-y-1">
          {MEMBERS.map((member) => (
            <OrganizationMemberRow
              key={member._id}
              member={member}
              role={member.role}
              currentUserEmail={viewer}
              canEditRole={isOwner && member.role !== "owner"}
              onRoleChange={
                isOwner && member.role !== "owner" ? () => {} : undefined
              }
              onTransferOwnership={
                isOwner && member.role !== "owner" ? () => {} : undefined
              }
              onRemove={
                isOwner && member.role !== "owner" ? () => {} : undefined
              }
            />
          ))}
        </div>
        <div className="space-y-1 pt-2">
          <OrganizationMemberRow
            member={INVITE}
            currentUserEmail={viewer}
            isPending
            onRemove={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Work organizations/Join requests",
  component: MembersList,
  parameters: { layout: "fullscreen" },
  args: { viewer: "sam@acme.com", requests: [JO] },
} satisfies Meta<typeof MembersList>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 1B-4: the owner, Sam, sees Jo's request first in the list. */
export const Owner: Story = {};

/** 1B-5: an admin, Riley, sees the same request with Approve and Decline. */
export const Admin: Story = { args: { viewer: "riley@acme.com" } };

/** Two requests, one from two days ago. */
export const TwoRequests: Story = { args: { requests: [JO, MORGAN] } };

/** No requests: the list looks as it does today. */
export const NoRequests: Story = { args: { requests: [] } };
