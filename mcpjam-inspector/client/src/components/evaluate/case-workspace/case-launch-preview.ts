import { toast } from "sonner";
import { convexErrMessage } from "@/lib/convex-error";
import { aiLaunchRefusalSentence } from "@/lib/ai-launch-problems";
import { modelTarget, modelTargetKey } from "@/lib/model-target";
import { isModelFree } from "@/shared/steps";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import type { SuiteRunReviewProps } from "../suite-run-review";
import {
  beginCaseLaunch,
  finishCaseLaunch,
  type CaseLaunchTarget,
} from "./pending-case-launches";

export function caseLaunchTarget(
  target: {
    hostId: string;
    modelId?: string | null;
    modelSelection?: ModelSelection;
  },
  names: ReadonlyMap<string, string | null>,
): CaseLaunchTarget {
  return {
    hostId: target.hostId,
    client: names.get(target.hostId) ?? "Client",
    model: target.modelId
      ? modelTargetKey(modelTarget(target.modelId, target.modelSelection))
      : "Client default",
  };
}

export function savedCaseTargets(
  props: Pick<
    SuiteRunReviewProps,
    "suite" | "cases" | "environments" | "hostNamesById"
  >,
): CaseLaunchTarget[] {
  const { suite, cases, environments = [], hostNamesById } = props;
  if (suite.environmentIds?.length)
    return suite.environmentIds.map((id) => {
      const environment = environments.find(
        (item) => item.environmentId === id,
      );
      return {
        ...caseLaunchTarget(environment ?? { hostId: "" }, hostNamesById),
        environmentId: id,
      };
    });
  return (
    suite.hostAttachments?.length
      ? suite.hostAttachments
      : [{ namedHostId: "" }]
  ).flatMap((host, targetIndex) => {
    const modelFree = isModelFree(cases[0]?.steps);
    const models = modelFree ? [] : (cases[0]?.models ?? []);
    return models.length
      ? models.map((model) => ({
          ...caseLaunchTarget(
            {
              hostId: host.namedHostId,
              modelId: model.model,
              modelSelection:
                model.selection?.source === "legacy"
                  ? undefined
                  : model.selection,
            },
            hostNamesById,
          ),
          targetIndex,
        }))
      : [
          {
            ...caseLaunchTarget(
              {
                hostId: host.namedHostId,
                modelId: modelFree ? undefined : suite.defaultConfig?.modelId,
              },
              hostNamesById,
            ),
            targetIndex,
          },
        ];
  });
}

export async function startCaseReview(
  props: Pick<
    SuiteRunReviewProps,
    "projectId" | "suite" | "cases" | "onClose" | "onStart"
  >,
  targets: CaseLaunchTarget[],
  count: number,
) {
  let id: string | undefined;
  try {
    id = beginCaseLaunch(
      {
        projectId: props.projectId ?? props.suite.projectId ?? "",
        suiteId: props.suite._id,
        caseId: props.cases[0]._id,
      },
      targets,
      count,
    );
    props.onClose();
    await props.onStart(props.suite, {
      iterationOverride: count,
      throwOnFailure: true,
      caseLaunchId: id,
    });
    finishCaseLaunch(id);
  } catch (error) {
    if (id) finishCaseLaunch(id, true);
    toast.error(
      aiLaunchRefusalSentence(error) ??
        convexErrMessage(error, "Could not start this run. Try again."),
      { id },
    );
  }
}
