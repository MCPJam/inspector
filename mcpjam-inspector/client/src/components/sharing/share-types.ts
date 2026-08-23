export type ShareMode =
  | "project_members"
  | "invited_only"
  | "anyone_with_link";

export type ShareGrantRole = "chat" | "viewer";

export type ShareMemberView = {
  id: string;
  email: string;
  userId?: string | null;
  revokedAt?: number;
  acceptedAt?: number;
  role?: ShareGrantRole;
  user?: { name?: string | null; imageUrl?: string | null } | null;
};

/**
 * Every share mutation resolves to this envelope. `policyVersion` is
 * present from day one so clients can treat it as the cache epoch.
 */
export type ShareSettingsEnvelope = {
  resourceType?: "scenario" | "conformanceRun" | "evalRun";
  resourceId: string;
  organizationId?: string;
  workspaceId?: string;
  projectId?: string;
  mode: ShareMode;
  /** Org ceiling; absent ⇒ no ceiling (legacy inspector / backend rollback). */
  maxShareMode?: ShareMode;
  policyVersion: number;
  inviteEpoch?: number;
  linkGrantEpoch?: number;
  allowGuestAccess?: boolean;
  link: {
    token: string;
    path?: string;
    url?: string;
    rotatedAt?: number;
    updatedAt?: number;
  } | null;
  linkExpiresAt?: number;
  artifactGeneration?: number;
  artifactStatus?: "building" | "ready" | "failed";
  members: ShareMemberView[];
};

export type ShareAccessOption = {
  value: string;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type ShareSectionCopy = {
  linkLabel: string;
  inviteLabel?: string;
  accessLabel?: string;
  hasAccessLabel?: string;
  invitedLabel?: string;
  signedOutMessage?: string;
  withheldLabel?: string;
  emptyLinkLabel?: string;
  rotateLabel?: string;
  rotateConfirmTitle?: string;
  rotateConfirmBody?: string;
  revokeAllLabel?: string;
};
