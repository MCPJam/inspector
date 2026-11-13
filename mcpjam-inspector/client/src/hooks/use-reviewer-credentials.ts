/**
 * A submission's reviewer credentials, kept as two project secrets named for
 * it: `MCPJAM_REVIEWER_<SUBMISSION>_EMAIL` and `_PASSWORD`. Delivery is
 * materialized, because the sign-in browser types them, and the backend
 * refuses a reviewer secret outside that prefix.
 *
 * NAMES ONLY. A value goes from the form into `save` and on to the secrets
 * API's own write. Nothing here keeps it, and the list read here is metadata.
 *
 * WHO CAN USE THEM. A project admin saves them for the project, so a teammate
 * can rehearse or resume with them; anyone else saves personal ones, as the
 * secrets form does for them.
 */
import { useCallback, useMemo } from "react";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useProjectMembers } from "@/hooks/useProjects";
import {
  useCreateProjectSecret,
  useProjectSecrets,
  useUpdateProjectSecret,
} from "@/hooks/useProjectSecrets";

const PREFIX = "MCPJAM_REVIEWER_";

export interface ReviewerSecretNames {
  usernameSecretName: string;
  passwordSecretName: string;
}

export function reviewerSecretNames(submissionId: string): ReviewerSecretNames {
  const id = submissionId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    usernameSecretName: `${PREFIX}${id}_EMAIL`,
    passwordSecretName: `${PREFIX}${id}_PASSWORD`,
  };
}

export function useReviewerCredentials({
  projectId,
  submissionId,
}: {
  projectId: string;
  submissionId: string;
}) {
  // A guest cannot read the project's secrets, nor save one.
  const member = useIsMemberActor();
  const secrets = useProjectSecrets(projectId);
  const role = useProjectMembers({
    isAuthenticated: member === true,
    projectId,
  });
  const createSecret = useCreateProjectSecret();
  const updateSecret = useUpdateProjectSecret();
  const names = useMemo(
    () => reviewerSecretNames(submissionId),
    [submissionId],
  );
  const rows = useMemo(
    () =>
      secrets &&
      [names.usernameSecretName, names.passwordSecretName].map((name) =>
        secrets.find((row) => row.name === name),
      ),
    [secrets, names],
  );
  const saved = rows?.every(Boolean);

  const save = useCallback(
    async (email: string, password: string) => {
      const sharing = role.canManageMembers ? "project" : "user";
      const writes = [
        { value: email, name: names.usernameSecretName, what: "email" },
        { value: password, name: names.passwordSecretName, what: "password" },
      ];
      for (const [index, { value, name, what }] of writes.entries()) {
        const row = rows?.[index];
        // A secret that exists is rotated, so its sharing stays as it was.
        await (row
          ? updateSecret({
              projectId,
              secretId: row.secretId,
              value,
              delivery: "materialized",
            })
          : createSecret({
              projectId,
              name,
              value,
              delivery: "materialized",
              sharing,
              description: `Directory reviewer ${what}, saved from the Readiness page`,
            }));
      }
    },
    [createSecret, names, projectId, role.canManageMembers, rows, updateSecret],
  );

  return {
    names,
    /** `undefined` until it is known whether the viewer is a member. */
    member,
    /** `undefined` while the list loads. A guest cannot read it: never saved. */
    saved: member === false ? false : saved,
    /** Who can use them: the saved rows' sharing, or what a save would choose. */
    personal: saved
      ? Boolean(rows?.some((row) => row?.sharing === "user"))
      : !role.canManageMembers,
    /** A member saves once the role has decided the sharing. */
    canSave: member === true && !role.isLoading,
    save,
  };
}

export type ReviewerCredentials = ReturnType<typeof useReviewerCredentials>;
