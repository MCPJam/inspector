import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import DynamicJsonForm from "./DynamicJsonForm";
import { JsonSchemaType, JsonValue } from "@/lib/utils/json/jsonUtils";
import { generateDefaultValue } from "@/lib/utils/json/schemaUtils";
import Ajv from "ajv";

// TODO: This is a temporary type for the elicitation request. Move this elsewhere.
export interface ElicitationRequest {
  id: number;
  message: string;
  requestedSchema: JsonSchemaType;
  resolve: (response: ElicitationResponse) => void;
}

// TODO: This is a temporary type for the elicitation request. Move this elsewhere.
export interface ElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

interface ElicitationModalProps {
  request: ElicitationRequest | null;
  onClose: () => void;
}

// Helper to recursively remove 'enumNames' from schema
function stripEnumNames(schema: JsonSchemaType): JsonSchemaType {
  if (Array.isArray(schema)) {
    // Should not happen for root, but handle arrays of schemas
    return schema.map(stripEnumNames) as unknown as JsonSchemaType;
  }
  if (typeof schema !== 'object' || schema === null) return schema;
  const { enumNames, properties, items, ...rest } = schema as any;
  const cleaned: any = { ...rest };
  if (properties) {
    cleaned.properties = {};
    for (const key in properties) {
      cleaned.properties[key] = stripEnumNames(properties[key]);
    }
  }
  if (items) {
    cleaned.items = stripEnumNames(items);
  }
  return cleaned;
}

const ElicitationModal = ({ request, onClose }: ElicitationModalProps) => {
  const [formData, setFormData] = useState<JsonValue>({});
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (request) {
      const defaultValue = generateDefaultValue(request.requestedSchema);
      setFormData(defaultValue);
      setValidationError(null);
    }
  }, [request]);

  if (!request) return null;

  const validateEmailFormat = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const validateFormData = (
    data: JsonValue,
    schema: JsonSchemaType,
  ): boolean => {
    if (
      schema.type === "object" &&
      schema.properties &&
      typeof data === "object" &&
      data !== null
    ) {
      const dataObj = data as Record<string, unknown>;

      if (Array.isArray(schema.required)) {
        for (const field of schema.required) {
          const value = dataObj[field];
          if (value === undefined || value === null || value === "") {
            setValidationError(`Required field missing: ${field}`);
            return false;
          }
        }
      }

      for (const [fieldName, fieldValue] of Object.entries(dataObj)) {
        const fieldSchema = schema.properties[fieldName];
        if (
          fieldSchema &&
          fieldSchema.format === "email" &&
          typeof fieldValue === "string"
        ) {
          if (!validateEmailFormat(fieldValue)) {
            setValidationError(`Invalid email format: ${fieldName}`);
            return false;
          }
        }
      }
    }

    return true;
  };

  const handleAccept = () => {
    try {
      if (!validateFormData(formData, request.requestedSchema)) {
        return;
      }

      const ajv = new Ajv();
      const cleanedSchema = stripEnumNames(request.requestedSchema);
      const validate = ajv.compile(cleanedSchema);
      const isValid = validate(formData);

      if (!isValid) {
        const errorMessage = ajv.errorsText(validate.errors);
        setValidationError(errorMessage);
        return;
      }

      request.resolve({
        action: "accept",
        content: formData as Record<string, unknown>,
      });
      onClose();
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : "Validation failed",
      );
    }
  };

  const handleReject = () => {
    request.resolve({ action: "decline" });
    onClose();
  };

  const handleCancel = () => {
    request.resolve({ action: "cancel" });
    onClose();
  };

  const schemaTitle = request.requestedSchema.title || "Information Request";
  const schemaDescription = request.requestedSchema.description;

  return (
    <Dialog open={true} onOpenChange={handleCancel}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{schemaTitle}</DialogTitle>
          <DialogDescription className="space-y-2">
            <span className="block">{request.message}</span>
            {schemaDescription && (
              <span className="block text-sm text-muted-foreground">
                {schemaDescription}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <DynamicJsonForm
            schema={request.requestedSchema}
            value={formData}
            onChange={(newValue: JsonValue) => {
              setFormData(newValue);
              setValidationError(null);
            }}
          />

          {validationError && (
            <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
              <div className="text-sm text-red-600 dark:text-red-400">
                <strong>Validation Error:</strong> {validationError}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={handleReject}>
            Decline
          </Button>
          <Button onClick={handleAccept}>Submit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ElicitationModal;
