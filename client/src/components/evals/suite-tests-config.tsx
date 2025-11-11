import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pencil, Trash2, Plus, Check, X } from "lucide-react";
import type { EvalSuite, EvalSuiteConfigTest } from "./types";

interface SuiteTestsConfigProps {
  suite: EvalSuite;
  onUpdate: (tests: EvalSuiteConfigTest[]) => void;
}

export function SuiteTestsConfig({ suite, onUpdate }: SuiteTestsConfigProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [tests, setTests] = useState<EvalSuiteConfigTest[]>(
    // Ensure all tests have expectedToolCalls array
    (suite.config?.tests || []).map(test => ({
      ...test,
      expectedToolCalls: test.expectedToolCalls || []
    }))
  );
  const [editForm, setEditForm] = useState<EvalSuiteConfigTest | null>(null);

  const startEdit = (index: number) => {
    setEditingIndex(index);
    // Ensure expectedToolCalls is always an array
    const test = tests[index];
    setEditForm({
      ...test,
      expectedToolCalls: test.expectedToolCalls || []
    });
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditForm(null);
  };

  const saveEdit = () => {
    if (editingIndex === null || !editForm) return;

    const updated = [...tests];
    updated[editingIndex] = editForm;
    setTests(updated);
    onUpdate(updated);
    cancelEdit();
  };

  const deleteTest = (index: number) => {
    const updated = tests.filter((_, i) => i !== index);
    setTests(updated);
    onUpdate(updated);
  };

  const addTest = () => {
    const newTest: EvalSuiteConfigTest = {
      title: "New test",
      query: "",
      provider: tests[0]?.provider || "anthropic",
      model: tests[0]?.model || "claude-3-5-sonnet-20241022",
      runs: 1,
      expectedToolCalls: [],
    };
    const updated = [...tests, newTest];
    setTests(updated);
    startEdit(updated.length - 1);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Test Configuration</h3>
          <p className="text-sm text-muted-foreground">
            View and edit the test cases in this suite
          </p>
        </div>
        <Button onClick={addTest} size="sm">
          <Plus className="h-4 w-4 mr-2" />
          Add test
        </Button>
      </div>

      {tests.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">No tests configured</p>
          <Button onClick={addTest} className="mt-4" variant="outline">
            <Plus className="h-4 w-4 mr-2" />
            Add your first test
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {tests.map((test, index) => (
            <Card key={index} className="p-4">
              {editingIndex === index && editForm ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Title</Label>
                    <Input
                      value={editForm.title}
                      onChange={(e) =>
                        setEditForm({ ...editForm, title: e.target.value })
                      }
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
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Provider</Label>
                      <Input
                        value={editForm.provider}
                        onChange={(e) =>
                          setEditForm({ ...editForm, provider: e.target.value })
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Model</Label>
                      <Input
                        value={editForm.model}
                        onChange={(e) =>
                          setEditForm({ ...editForm, model: e.target.value })
                        }
                      />
                    </div>
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
                    <Label>Expected tool calls (comma-separated)</Label>
                    <Input
                      value={(editForm.expectedToolCalls || []).join(", ")}
                      onChange={(e) =>
                        setEditForm({
                          ...editForm,
                          expectedToolCalls: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
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
                      <h4 className="font-semibold">{test.title}</h4>
                      <p className="text-sm text-muted-foreground mt-1">
                        {test.query}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-3">
                        <Badge variant="outline">
                          {test.provider} · {test.model}
                        </Badge>
                        <Badge variant="outline">{test.runs} runs</Badge>
                        {(test.expectedToolCalls || []).length > 0 && (
                          <Badge variant="outline">
                            Expects: {(test.expectedToolCalls || []).join(", ")}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => startEdit(index)}
                        size="sm"
                        variant="ghost"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        onClick={() => deleteTest(index)}
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
