import React, { useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { MessageSquare, X, Check, RefreshCw } from "lucide-react";
import { DialogElicitation } from "./ToolsTab";

interface FormField {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  value: any;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  pattern?: string;
}

interface ElicitationDialogProps {
  elicitationRequest: DialogElicitation | null;
  onResponse: (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => Promise<void>;
  loading?: boolean;
}

export function ElicitationDialog({
  elicitationRequest,
  onResponse,
  loading = false,
}: ElicitationDialogProps) {
  const [fields, setFields] = useState<FormField[]>([]);

  // Generate form fields from schema when request changes
  React.useEffect(() => {
    if (elicitationRequest?.schema) {
      generateFormFields(elicitationRequest.schema);
    } else {
      setFields([]);
    }
  }, [elicitationRequest]);

  const generateFormFields = (schema: any) => {
    if (!schema || !schema.properties) {
      setFields([]);
      return;
    }

    const formFields: FormField[] = [];
    const required = schema.required || [];

    Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
      const fieldType = prop.enum ? "enum" : prop.type || "string";
      formFields.push({
        name: key,
        type: fieldType,
        description: prop.description,
        required: required.includes(key),
        value: getDefaultValue(fieldType, prop.enum),
        enum: prop.enum,
        minimum: prop.minimum,
        maximum: prop.maximum,
        pattern: prop.pattern,
      });
    });

    setFields(formFields);
  };

  const getDefaultValue = (type: string, enumValues?: string[]) => {
    switch (type) {
      case "enum":
        return enumValues?.[0] || "";
      case "string":
        return "";
      case "number":
      case "integer":
        return "";
      case "boolean":
        return false;
      case "array":
        return [];
      case "object":
        return {};
      default:
        return "";
    }
  };

  const updateFieldValue = (fieldName: string, value: any) => {
    setFields((prev) =>
      prev.map((field) =>
        field.name === fieldName ? { ...field, value } : field,
      ),
    );
  };

  const buildParameters = (): Record<string, any> => {
    const params: Record<string, any> = {};
    fields.forEach((field) => {
      if (
        field.value !== "" &&
        field.value !== null &&
        field.value !== undefined
      ) {
        let processedValue = field.value;

        if (field.type === "number" || field.type === "integer") {
          processedValue = Number(field.value);
        } else if (field.type === "boolean") {
          processedValue = Boolean(field.value);
        } else if (field.type === "array" || field.type === "object") {
          try {
            processedValue = JSON.parse(field.value);
          } catch {
            processedValue = field.value;
          }
        }

        params[field.name] = processedValue;
      }
    });
    return params;
  };

  const handleResponse = async (action: "accept" | "decline" | "cancel") => {
    if (action === "accept") {
      // Validate required fields
      const missingFields = fields.filter(
        (field) => field.required && (!field.value || field.value === ""),
      );

      if (missingFields.length > 0) {
        // You could show validation errors here
        return;
      }

      const parameters = buildParameters();
      await onResponse(action, parameters);
    } else {
      await onResponse(action);
    }
  };

  const renderField = (field: FormField) => {
    if (field.type === "enum") {
      return (
        <Select
          value={field.value}
          onValueChange={(value) => updateFieldValue(field.name, value)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            {field.enum?.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (field.type === "boolean") {
      return (
        <div className="flex items-center space-x-3 py-2">
          <input
            type="checkbox"
            checked={field.value}
            onChange={(e) => updateFieldValue(field.name, e.target.checked)}
            className="w-4 h-4 text-primary bg-background border-border rounded focus:ring-ring focus:ring-2"
          />
          <span className="text-sm">
            {field.value ? "Enabled" : "Disabled"}
          </span>
        </div>
      );
    } else if (field.type === "array" || field.type === "object") {
      return (
        <Textarea
          value={
            typeof field.value === "string"
              ? field.value
              : JSON.stringify(field.value, null, 2)
          }
          onChange={(e) => updateFieldValue(field.name, e.target.value)}
          placeholder={`Enter ${field.type} as JSON`}
          className="font-mono text-sm h-20 resize-none"
        />
      );
    } else {
      return (
        <Input
          type={
            field.type === "number" || field.type === "integer"
              ? "number"
              : "text"
          }
          value={field.value}
          onChange={(e) => updateFieldValue(field.name, e.target.value)}
          placeholder={`Enter ${field.name}`}
          className="text-sm"
        />
      );
    }
  };

  return (
    <Dialog open={!!elicitationRequest} onOpenChange={() => {}}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <MessageSquare className="h-3 w-3" />
            Elicitation Request
          </DialogTitle>
          <DialogDescription className="text-md font-bold">
            {elicitationRequest?.message}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {fields.map((field) => (
            <div key={field.name}>
              <div className="flex items-start justify-between mb-2">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">{field.name}</Label>
                    {field.required && (
                      <div
                        className="w-1.5 h-1.5 bg-red-500 rounded-full"
                        title="Required field"
                      />
                    )}
                  </div>
                  {field.description && (
                    <p className="text-xs text-muted-foreground">
                      {field.description}
                    </p>
                  )}
                </div>
                <Badge variant="secondary" className="text-xs">
                  {field.type}
                </Badge>
              </div>
              {renderField(field)}
            </div>
          ))}
        </div>

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => handleResponse("cancel")}
            disabled={loading}
          >
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => handleResponse("decline")}
            disabled={loading}
          >
            Decline
          </Button>
          <Button onClick={() => handleResponse("accept")} disabled={loading}>
            {loading ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
