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
import { AlertCircle } from "lucide-react";
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
  if (typeof schema !== "object" || schema === null) return schema;
  const { properties, items, ...rest } = schema as JsonSchemaType;
  const cleaned: JsonSchemaType = { ...rest };
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
          <DialogTitle className="text-lg font-semibold">
            {schemaTitle}
          </DialogTitle>
          <DialogDescription className="text-sm">
            {request.message}
            {schemaDescription && (
              <div className="mt-2 text-xs text-muted-foreground">
                {schemaDescription}
              </div>
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
            <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                <div className="text-sm text-destructive">
                  {validationError}
                </div>
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
          <Button onClick={handleAccept}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ElicitationModal;
