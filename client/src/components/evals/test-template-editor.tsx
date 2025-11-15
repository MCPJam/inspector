import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil, Check, X } from "lucide-react";
import { ExpectedToolsEditor } from "./expected-tools-editor";
import { toast } from "sonner";

interface TestTemplate {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  judgeRequirement?: string;
  advancedConfig?: Record<string, unknown>;
}

interface TestTemplateEditorProps {
  suiteId: string;
  selectedTestCaseId: string;
}

export function TestTemplateEditor({
  suiteId,
  selectedTestCaseId,
}: TestTemplateEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<TestTemplate | null>(null);
  const [availableTools, setAvailableTools] = useState<
    Array<{ name: string; description?: string; inputSchema?: any }>
  >([]);

  // Get all test cases for this suite
  const testCases = useQuery("evals:getTestCasesBySuite" as any, {
    suiteId,
  }) as any[] | undefined;

  const updateTestCaseMutation = useMutation("evals:updateTestCase" as any);

  // Find the test case
  const currentTestCase = useMemo(() => {
    if (!testCases) return null;
    return testCases.find((tc: any) => tc._id === selectedTestCaseId) || null;
  }, [testCases, selectedTestCaseId]);

  // Get suite config for servers (to fetch available tools)
  const suiteConfig = useQuery("evals:getSuiteOverview" as any, {}) as any;
  const suite = useMemo(() => {
    if (!suiteConfig) return null;
    return suiteConfig.find((entry: any) => entry.suite._id === suiteId)?.suite;
  }, [suiteConfig, suiteId]);

  // Fetch available tools from selected servers
  useEffect(() => {
    async function fetchTools() {
      if (!suite) return;

      const serverIds = suite.config?.environment?.servers || [];
      if (serverIds.length === 0) {
        setAvailableTools([]);
        return;
      }

      try {
        const response = await fetch("/api/mcp/list-tools", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverIds }),
        });

        if (response.ok) {
          const data = await response.json();
          setAvailableTools(data.tools || []);
        }
      } catch (error) {
        console.error("Failed to fetch tools:", error);
      }
    }

    fetchTools();
  }, [suite]);

  const startEdit = () => {
    if (currentTestCase) {
      setEditForm({
        title: currentTestCase.title,
        query: currentTestCase.query,
        runs: currentTestCase.runs,
        expectedToolCalls: currentTestCase.expectedToolCalls || [],
        judgeRequirement: currentTestCase.judgeRequirement,
        advancedConfig: currentTestCase.advancedConfig,
      });
      setIsEditing(true);
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditForm(null);
  };

  const saveEdit = async () => {
    if (!editForm || !currentTestCase) return;

    try {
      await updateTestCaseMutation({
        testCaseId: currentTestCase._id,
        title: editForm.title,
        query: editForm.query,
        runs: editForm.runs,
        expectedToolCalls: editForm.expectedToolCalls,
        judgeRequirement: editForm.judgeRequirement,
        advancedConfig: editForm.advancedConfig,
      });

      toast.success("Test case updated successfully");
      setIsEditing(false);
      setEditForm(null);
    } catch (error) {
      console.error("Failed to update test case:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to update test case"
      );
    }
  };

  if (!currentTestCase) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading test case...</p>
      </Card>
    );
  }

  const modelCount = currentTestCase.models?.length || 0;

  return (
    <Card className="p-4">
      {isEditing && editForm ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={editForm.title}
              onChange={(e) =>
                setEditForm({ ...editForm, title: e.target.value })
              }
              placeholder="e.g., Add two numbers"
            />
          </div>

          <div className="space-y-2">
            <Label>Query</Label>
            <Textarea
              value={editForm.query}
              onChange={(e) =>
                setEditForm({ ...editForm, query: e.target.value })
              }
              rows={3}
              placeholder="e.g., Add 5 and 7 together"
            />
          </div>

          <div className="space-y-2">
            <Label>Runs per test</Label>
            <Input
              type="number"
              min={1}
              value={editForm.runs}
              onChange={(e) =>
                setEditForm({
                  ...editForm,
                  runs: parseInt(e.target.value) || 1,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Expected tool calls</Label>
            <ExpectedToolsEditor
              toolCalls={editForm.expectedToolCalls || []}
              onChange={(toolCalls) =>
                setEditForm({
                  ...editForm,
                  expectedToolCalls: toolCalls,
                })
              }
              availableTools={availableTools}
            />
          </div>

          <div className="flex gap-2">
            <Button onClick={saveEdit} size="sm">
              <Check className="h-4 w-4 mr-2" />
              Save
            </Button>
            <Button onClick={cancelEdit} size="sm" variant="outline">
              <X className="h-4 w-4 mr-2" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h4 className="font-semibold mb-2">Test Configuration</h4>
              <div className="space-y-2">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Title</div>
                  <p className="text-sm">{currentTestCase.title}</p>
                </div>
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Query</div>
                  <p className="text-sm italic">"{currentTestCase.query}"</p>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Badge variant="outline">{currentTestCase.runs} runs</Badge>
                  <Badge variant="outline">{modelCount} model{modelCount === 1 ? '' : 's'}</Badge>
                  {(currentTestCase.expectedToolCalls || []).length > 0 && (
                    <Badge variant="outline">
                      Expects:{" "}
                      {(currentTestCase.expectedToolCalls || [])
                        .map((t) => t.toolName)
                        .join(", ")}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
            <Button onClick={startEdit} size="sm" variant="ghost">
              <Pencil className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
