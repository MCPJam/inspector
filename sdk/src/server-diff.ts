import type {
  StructuredCaseClassification,
  StructuredCaseResult,
  StructuredRunReport,
} from "./structured-reporting.js";
import { summarizeStructuredCases } from "./structured-reporting.js";
import {
  collectServerSnapshot,
  normalizeServerSnapshot,
  type CollectServerSnapshotInput,
  type NormalizedServerSnapshot,
  type ServerSnapshotTool,
} from "./server-snapshot.js";

export type SnapshotDiffClassification = StructuredCaseClassification;
export type SnapshotDiffEntityType =
  | "tools"
  | "resources"
  | "resourceTemplates"
  | "prompts"
  | "initInfo"
  | "capabilities";
export type SnapshotDiffChangeType = "added" | "removed" | "modified";
export type SnapshotDiffFailOn = "breaking" | "any" | "none";

export interface SnapshotFieldChange {
  field: string;
  changeType: SnapshotDiffChangeType;
  classification: SnapshotDiffClassification;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface SnapshotEntityChange {
  entityType: SnapshotDiffEntityType;
  entityId: string;
  changeType: SnapshotDiffChangeType;
  classification: SnapshotDiffClassification;
  before?: unknown;
  after?: unknown;
  fieldChanges: SnapshotFieldChange[];
}

export interface SnapshotEntityClassificationSummary {
  total: number;
  breaking: number;
  non_breaking: number;
  informational: number;
}

export interface SnapshotDiffSummary {
  totalChanges: number;
  byClassification: Record<SnapshotDiffClassification, number>;
  byEntityType: Record<
    SnapshotDiffEntityType,
    SnapshotEntityClassificationSummary
  >;
}

export interface SnapshotSurfaceSummary {
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  toolsMetadata: number;
  hasInitInfo: boolean;
  hasCapabilities: boolean;
}

export interface ServerSnapshotDiffResult {
  passed: boolean;
  failOn: SnapshotDiffFailOn;
  summary: SnapshotDiffSummary;
  changes: SnapshotEntityChange[];
  baselineSummary: SnapshotSurfaceSummary;
  currentSummary: SnapshotSurfaceSummary;
}

export interface DiffServerSnapshotsOptions {
  failOn?: SnapshotDiffFailOn;
}

export interface CollectAndDiffServerSnapshotInput<
  TTarget = unknown,
> extends CollectServerSnapshotInput<TTarget> {
  baseline: unknown;
  failOn?: SnapshotDiffFailOn;
}

export async function collectAndDiffServerSnapshot<TTarget = unknown>(
  input: CollectAndDiffServerSnapshotInput<TTarget>
): Promise<ServerSnapshotDiffResult> {
  const current = await collectServerSnapshot(input);
  return diffServerSnapshots(input.baseline, current, {
    failOn: input.failOn,
  });
}

export function diffServerSnapshots(
  left: unknown,
  right: unknown,
  options: DiffServerSnapshotsOptions = {}
): ServerSnapshotDiffResult {
  const baseline = normalizeServerSnapshot(left);
  const current = normalizeServerSnapshot(right);
  const changes = [
    ...diffTools(baseline, current),
    ...diffResources(baseline, current),
    ...diffResourceTemplates(baseline, current),
    ...diffPrompts(baseline, current),
    ...diffProtocolValue("initInfo", baseline.initInfo, current.initInfo),
    ...diffProtocolValue(
      "capabilities",
      baseline.capabilities,
      current.capabilities
    ),
  ];
  const failOn = options.failOn ?? "breaking";

  return {
    passed: evaluateDiffPass(changes, failOn),
    failOn,
    summary: summarizeDiffChanges(changes),
    changes,
    baselineSummary: summarizeSnapshotSurface(baseline),
    currentSummary: summarizeSnapshotSurface(current),
  };
}

export function buildServerDiffReport(
  diff: ServerSnapshotDiffResult,
  options: {
    durationMs?: number;
    metadata?: Record<string, unknown>;
  } = {}
): StructuredRunReport {
  const cases = flattenDiffCases(diff);

  return {
    schemaVersion: 1,
    kind: "server-diff",
    passed: diff.passed,
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: options.durationMs ?? 0,
    metadata: {
      failOn: diff.failOn,
      baselineSummary: diff.baselineSummary,
      currentSummary: diff.currentSummary,
      ...(options.metadata ?? {}),
    },
  };
}

function diffTools(
  baseline: NormalizedServerSnapshot,
  current: NormalizedServerSnapshot
): SnapshotEntityChange[] {
  type ToolWithMetadata = {
    tool?: ServerSnapshotTool;
    metadata?: unknown;
  };

  const baselineTools = new Map(
    baseline.tools.map((tool) => [
      tool.name,
      {
        tool,
        metadata: baseline.toolsMetadata[tool.name],
      },
    ])
  ) as Map<string, ToolWithMetadata>;
  for (const [toolName, metadata] of Object.entries(baseline.toolsMetadata)) {
    if (!baselineTools.has(toolName)) {
      baselineTools.set(toolName, { tool: undefined, metadata });
    }
  }

  const currentTools = new Map(
    current.tools.map((tool) => [
      tool.name,
      {
        tool,
        metadata: current.toolsMetadata[tool.name],
      },
    ])
  ) as Map<string, ToolWithMetadata>;
  for (const [toolName, metadata] of Object.entries(current.toolsMetadata)) {
    if (!currentTools.has(toolName)) {
      currentTools.set(toolName, { tool: undefined, metadata });
    }
  }

  const toolNames = new Set([
    ...Array.from(baselineTools.keys()),
    ...Array.from(currentTools.keys()),
  ]);

  const changes: SnapshotEntityChange[] = [];
  for (const toolName of Array.from(toolNames).sort((left, right) =>
    left.localeCompare(right)
  )) {
    const before = baselineTools.get(toolName);
    const after = currentTools.get(toolName);

    if (!before) {
      changes.push({
        entityType: "tools",
        entityId: toolName,
        changeType: "added",
        classification: "non_breaking",
        after: buildToolComparableValue(after?.tool, after?.metadata),
        fieldChanges: [],
      });
      continue;
    }

    if (!after) {
      changes.push({
        entityType: "tools",
        entityId: toolName,
        changeType: "removed",
        classification: "breaking",
        before: buildToolComparableValue(before.tool, before.metadata),
        fieldChanges: [],
      });
      continue;
    }

    const fieldChanges: SnapshotFieldChange[] = [];
    maybePushFieldChange(fieldChanges, {
      field: "description",
      before: before.tool?.description,
      after: after.tool?.description,
      classification: "informational",
    });
    const inputSchemaChange = classifySchemaFieldChange(
      "inputSchema",
      before.tool?.inputSchema,
      after.tool?.inputSchema
    );
    if (inputSchemaChange) {
      fieldChanges.push(inputSchemaChange);
    }
    const outputSchemaChange = classifySchemaFieldChange(
      "outputSchema",
      before.tool?.outputSchema,
      after.tool?.outputSchema
    );
    if (outputSchemaChange) {
      fieldChanges.push(outputSchemaChange);
    }
    maybePushFieldChange(fieldChanges, {
      field: "metadata",
      before: before.metadata,
      after: after.metadata,
      classification: "informational",
    });

    if (fieldChanges.length > 0) {
      changes.push({
        entityType: "tools",
        entityId: toolName,
        changeType: "modified",
        classification: maxClassification(
          fieldChanges.map((change) => change.classification)
        ),
        before: buildToolComparableValue(before.tool, before.metadata),
        after: buildToolComparableValue(after.tool, after.metadata),
        fieldChanges,
      });
    }
  }

  return changes;
}

function diffResources(
  baseline: NormalizedServerSnapshot,
  current: NormalizedServerSnapshot
): SnapshotEntityChange[] {
  return diffSimpleEntities(
    "resources",
    baseline.resources,
    current.resources,
    (resource) => resource.uri,
    ["name", "description", "mimeType"]
  );
}

function diffResourceTemplates(
  baseline: NormalizedServerSnapshot,
  current: NormalizedServerSnapshot
): SnapshotEntityChange[] {
  return diffSimpleEntities(
    "resourceTemplates",
    baseline.resourceTemplates,
    current.resourceTemplates,
    (template) => template.uriTemplate,
    ["name", "description", "mimeType"]
  );
}

function diffPrompts(
  baseline: NormalizedServerSnapshot,
  current: NormalizedServerSnapshot
): SnapshotEntityChange[] {
  return diffSimpleEntities(
    "prompts",
    baseline.prompts,
    current.prompts,
    (prompt) => prompt.name,
    ["description", "arguments"]
  );
}

function diffSimpleEntities<TEntity extends object, TEntityId extends string>(
  entityType: Exclude<
    SnapshotDiffEntityType,
    "tools" | "initInfo" | "capabilities"
  >,
  baselineItems: TEntity[],
  currentItems: TEntity[],
  getId: (entity: TEntity) => TEntityId,
  comparableFields: Array<Extract<keyof TEntity, string>>
): SnapshotEntityChange[] {
  const baselineById = new Map(
    baselineItems.map((entity) => [getId(entity), entity])
  );
  const currentById = new Map(
    currentItems.map((entity) => [getId(entity), entity])
  );

  const ids = new Set([
    ...Array.from(baselineById.keys()),
    ...Array.from(currentById.keys()),
  ]);

  const changes: SnapshotEntityChange[] = [];
  for (const entityId of Array.from(ids).sort((left, right) =>
    left.localeCompare(right)
  )) {
    const before = baselineById.get(entityId);
    const after = currentById.get(entityId);

    if (!before) {
      changes.push({
        entityType,
        entityId,
        changeType: "added",
        classification: "non_breaking",
        after,
        fieldChanges: [],
      });
      continue;
    }

    if (!after) {
      changes.push({
        entityType,
        entityId,
        changeType: "removed",
        classification: "breaking",
        before,
        fieldChanges: [],
      });
      continue;
    }

    const fieldChanges: SnapshotFieldChange[] = [];
    for (const field of comparableFields) {
      maybePushFieldChange(fieldChanges, {
        field,
        before: before[field],
        after: after[field],
        classification: "informational",
      });
    }

    if (fieldChanges.length > 0) {
      changes.push({
        entityType,
        entityId,
        changeType: "modified",
        classification: "informational",
        before,
        after,
        fieldChanges,
      });
    }
  }

  return changes;
}

function diffProtocolValue(
  entityType: Extract<SnapshotDiffEntityType, "initInfo" | "capabilities">,
  baselineValue: unknown,
  currentValue: unknown
): SnapshotEntityChange[] {
  if (isDeepEqual(baselineValue, currentValue)) {
    return [];
  }

  return [
    {
      entityType,
      entityId: entityType,
      changeType: "modified",
      classification: "informational",
      before: baselineValue,
      after: currentValue,
      fieldChanges: [
        {
          field: entityType,
          changeType: "modified",
          classification: "informational",
          before: baselineValue,
          after: currentValue,
        },
      ],
    },
  ];
}

function summarizeDiffChanges(
  changes: SnapshotEntityChange[]
): SnapshotDiffSummary {
  const byEntityType: SnapshotDiffSummary["byEntityType"] = {
    tools: createEntityClassificationSummary(),
    resources: createEntityClassificationSummary(),
    resourceTemplates: createEntityClassificationSummary(),
    prompts: createEntityClassificationSummary(),
    initInfo: createEntityClassificationSummary(),
    capabilities: createEntityClassificationSummary(),
  };
  const byClassification: SnapshotDiffSummary["byClassification"] = {
    breaking: 0,
    non_breaking: 0,
    informational: 0,
  };

  for (const change of changes) {
    byClassification[change.classification] += 1;

    const bucket = byEntityType[change.entityType];
    bucket.total += 1;
    bucket[change.classification] += 1;
  }

  return {
    totalChanges: changes.length,
    byClassification,
    byEntityType,
  };
}

function summarizeSnapshotSurface(
  snapshot: NormalizedServerSnapshot
): SnapshotSurfaceSummary {
  return {
    tools: snapshot.tools.length,
    resources: snapshot.resources.length,
    resourceTemplates: snapshot.resourceTemplates.length,
    prompts: snapshot.prompts.length,
    toolsMetadata: Object.keys(snapshot.toolsMetadata).length,
    hasInitInfo: snapshot.initInfo !== null,
    hasCapabilities: snapshot.capabilities !== null,
  };
}

function evaluateDiffPass(
  changes: SnapshotEntityChange[],
  failOn: SnapshotDiffFailOn
): boolean {
  if (failOn === "none") {
    return true;
  }

  if (failOn === "any") {
    return changes.length === 0;
  }

  return !changes.some((change) => change.classification === "breaking");
}

function flattenDiffCases(
  diff: ServerSnapshotDiffResult
): StructuredCaseResult[] {
  return diff.changes.flatMap((change) => {
    if (change.changeType !== "modified" || change.fieldChanges.length === 0) {
      return [
        {
          id: `${entityTypeToCasePrefix(change.entityType)}:${change.entityId}`,
          title: `${change.changeType}-${change.entityId}`,
          category: entityTypeToCategory(change.entityType),
          passed: isClassificationBelowThreshold(
            change.classification,
            diff.failOn
          ),
          classification: change.classification,
          details: {
            changeType: change.changeType,
            before: change.before,
            after: change.after,
          },
          error: isClassificationBelowThreshold(
            change.classification,
            diff.failOn
          )
            ? undefined
            : describeClassificationFailure(change.classification, diff.failOn),
        },
      ];
    }

    return change.fieldChanges.map((fieldChange) => ({
      id: `${entityTypeToCasePrefix(change.entityType)}:${change.entityId}:${fieldChange.field}`,
      title: `${change.entityId}:${fieldChange.field}`,
      category: fieldToCategory(change.entityType, fieldChange.field),
      passed: isClassificationBelowThreshold(
        fieldChange.classification,
        diff.failOn
      ),
      classification: fieldChange.classification,
      details: {
        entityType: change.entityType,
        changeType: fieldChange.changeType,
        reason: fieldChange.reason,
        before: fieldChange.before,
        after: fieldChange.after,
      },
      error: isClassificationBelowThreshold(
        fieldChange.classification,
        diff.failOn
      )
        ? undefined
        : describeClassificationFailure(
            fieldChange.classification,
            diff.failOn
          ),
    }));
  });
}

function maybePushFieldChange(
  fieldChanges: SnapshotFieldChange[],
  input: {
    field: string;
    before: unknown;
    after: unknown;
    classification: SnapshotDiffClassification;
  }
): void {
  if (isDeepEqual(input.before, input.after)) {
    return;
  }

  fieldChanges.push({
    field: input.field,
    changeType: "modified",
    classification: input.classification,
    before: input.before,
    after: input.after,
  });
}

function classifySchemaFieldChange(
  field: "inputSchema" | "outputSchema",
  before: unknown,
  after: unknown
): SnapshotFieldChange | undefined {
  if (before === undefined && after === undefined) {
    return undefined;
  }

  if (isDeepEqual(before, after)) {
    return undefined;
  }

  if (before === undefined || after === undefined) {
    return {
      field,
      changeType: "modified",
      classification: "informational",
      reason: `${field} was ${before === undefined ? "added" : "removed"}.`,
      before,
      after,
    };
  }

  const reasons: Array<{
    classification: SnapshotDiffClassification;
    reason: string;
  }> = [];
  compareSchemaSubset(before, after, "", reasons);

  return {
    field,
    changeType: "modified",
    classification:
      reasons.length > 0
        ? maxClassification(reasons.map((reason) => reason.classification))
        : "informational",
    reason:
      reasons.length > 0
        ? reasons.map((reason) => reason.reason).join(" ")
        : `${field} changed in a way that could not be safely classified.`,
    before,
    after,
  };
}

function compareSchemaSubset(
  before: unknown,
  after: unknown,
  path: string,
  reasons: Array<{
    classification: SnapshotDiffClassification;
    reason: string;
  }>
): void {
  if (!isRecord(before) || !isRecord(after)) {
    return;
  }

  if (
    typeof before.type === "string" &&
    typeof after.type === "string" &&
    before.type !== after.type
  ) {
    reasons.push({
      classification: "breaking",
      reason: `${pathLabel(path)} changed type from "${before.type}" to "${after.type}".`,
    });
  }

  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const beforeValues = new Set(
      before.enum.map((value) => JSON.stringify(value))
    );
    const afterValues = new Set(
      after.enum.map((value) => JSON.stringify(value))
    );

    if (isStrictSubset(afterValues, beforeValues)) {
      reasons.push({
        classification: "breaking",
        reason: `${pathLabel(path)} narrowed its allowed enum values.`,
      });
    } else if (isStrictSubset(beforeValues, afterValues)) {
      reasons.push({
        classification: "non_breaking",
        reason: `${pathLabel(path)} widened its allowed enum values.`,
      });
    } else if (!setsEqual(beforeValues, afterValues)) {
      reasons.push({
        classification: "informational",
        reason: `${pathLabel(path)} changed enum values in a way that could not be safely classified.`,
      });
    }
  }

  const beforeProperties = asSchemaProperties(before.properties);
  const afterProperties = asSchemaProperties(after.properties);
  if (beforeProperties || afterProperties) {
    const beforeRequired = new Set(asStringArray(before.required));
    const afterRequired = new Set(asStringArray(after.required));
    const propertyNames = new Set([
      ...Object.keys(beforeProperties ?? {}),
      ...Object.keys(afterProperties ?? {}),
    ]);

    for (const propertyName of Array.from(propertyNames).sort((left, right) =>
      left.localeCompare(right)
    )) {
      const nestedPath = path ? `${path}.${propertyName}` : propertyName;
      const beforeProperty = beforeProperties?.[propertyName];
      const afterProperty = afterProperties?.[propertyName];

      if (!beforeProperty && afterProperty) {
        reasons.push({
          classification: afterRequired.has(propertyName)
            ? "breaking"
            : "non_breaking",
          reason: `${pathLabel(nestedPath)} was added${
            afterRequired.has(propertyName) ? " as a required property" : ""
          }.`,
        });
        continue;
      }

      if (beforeProperty && !afterProperty) {
        reasons.push({
          classification: "breaking",
          reason: `${pathLabel(nestedPath)} was removed.`,
        });
        continue;
      }

      if (beforeProperty && afterProperty) {
        if (
          !beforeRequired.has(propertyName) &&
          afterRequired.has(propertyName)
        ) {
          reasons.push({
            classification: "breaking",
            reason: `${pathLabel(nestedPath)} became required.`,
          });
        } else if (
          beforeRequired.has(propertyName) &&
          !afterRequired.has(propertyName)
        ) {
          reasons.push({
            classification: "non_breaking",
            reason: `${pathLabel(nestedPath)} is no longer required.`,
          });
        }

        compareSchemaSubset(beforeProperty, afterProperty, nestedPath, reasons);
      }
    }
  }
}

function buildToolComparableValue(
  tool: ServerSnapshotTool | undefined,
  metadata: unknown
): Record<string, unknown> {
  return {
    ...(tool ? { tool } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function entityTypeToCasePrefix(entityType: SnapshotDiffEntityType): string {
  switch (entityType) {
    case "tools":
      return "tool";
    case "resources":
      return "resource";
    case "resourceTemplates":
      return "resource-template";
    case "prompts":
      return "prompt";
    case "initInfo":
      return "initInfo";
    case "capabilities":
      return "capabilities";
  }
}

function entityTypeToCategory(entityType: SnapshotDiffEntityType): string {
  switch (entityType) {
    case "tools":
      return "tools";
    case "resources":
    case "resourceTemplates":
      return "resources";
    case "prompts":
      return "prompts";
    case "initInfo":
    case "capabilities":
      return "protocol";
  }
}

function fieldToCategory(
  entityType: SnapshotDiffEntityType,
  field: string
): string {
  if (
    entityType === "tools" &&
    (field === "inputSchema" || field === "outputSchema")
  ) {
    return "schemas";
  }

  return entityTypeToCategory(entityType);
}

function isClassificationBelowThreshold(
  classification: SnapshotDiffClassification,
  failOn: SnapshotDiffFailOn
): boolean {
  if (failOn === "none") {
    return true;
  }

  if (failOn === "any") {
    return false;
  }

  return classification !== "breaking";
}

function describeClassificationFailure(
  classification: SnapshotDiffClassification,
  failOn: SnapshotDiffFailOn
): string {
  if (failOn === "any") {
    return `Change classification "${classification}" failed the selected diff policy.`;
  }

  return `Change classification "${classification}" failed the selected diff policy.`;
}

function createEntityClassificationSummary(): SnapshotEntityClassificationSummary {
  return {
    total: 0,
    breaking: 0,
    non_breaking: 0,
    informational: 0,
  };
}

function maxClassification(
  classifications: SnapshotDiffClassification[]
): SnapshotDiffClassification {
  if (classifications.includes("breaking")) {
    return "breaking";
  }
  if (classifications.includes("non_breaking")) {
    return "non_breaking";
  }
  return "informational";
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asSchemaProperties(
  value: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function pathLabel(path: string): string {
  return path.length > 0 ? `Schema path "${path}"` : "Top-level schema";
}

function isStrictSubset(subset: Set<string>, superset: Set<string>): boolean {
  if (subset.size >= superset.size) {
    return false;
  }

  return Array.from(subset).every((value) => superset.has(value));
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size &&
    Array.from(left).every((value) => right.has(value))
  );
}
