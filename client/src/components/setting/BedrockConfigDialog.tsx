import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface BedrockConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessKeyId: string;
  secretKey: string;
  region: string;
  onAccessKeyIdChange: (value: string) => void;
  onSecretKeyChange: (value: string) => void;
  onRegionChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

const AWS_REGIONS = [
  // United States
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  // Asia Pacific
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
  { value: "ap-northeast-3", label: "Asia Pacific (Osaka)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  // Canada
  { value: "ca-central-1", label: "Canada (Central)" },
  // Europe
  { value: "eu-central-1", label: "Europe (Frankfurt)" },
  { value: "eu-west-1", label: "Europe (Ireland)" },
  { value: "eu-west-2", label: "Europe (London)" },
  { value: "eu-west-3", label: "Europe (Paris)" },
  { value: "eu-north-1", label: "Europe (Stockholm)" },
];

export function BedrockConfigDialog({
  open,
  onOpenChange,
  accessKeyId,
  secretKey,
  region,
  onAccessKeyIdChange,
  onSecretKeyChange,
  onRegionChange,
  onSave,
  onCancel,
}: BedrockConfigDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-white dark:bg-gray-800 p-2 flex items-center justify-center">
              <img
                src="/bedrock_logo.png"
                alt="AWS Bedrock Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <DialogTitle className="text-left pb-2">
                Configure Amazon Bedrock
              </DialogTitle>
              <DialogDescription className="text-left">
                Set up your AWS credentials for Bedrock
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="bedrock-access-key" className="text-sm font-medium">
              AWS Access Key ID
            </label>
            <Input
              id="bedrock-access-key"
              type="text"
              value={accessKeyId}
              onChange={(e) => onAccessKeyIdChange(e.target.value)}
              placeholder="AKIA..."
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="bedrock-secret-key" className="text-sm font-medium">
              AWS Secret Access Key
            </label>
            <Input
              id="bedrock-secret-key"
              type="password"
              value={secretKey}
              onChange={(e) => onSecretKeyChange(e.target.value)}
              placeholder="Enter secret key"
              className="mt-1"
            />
          </div>

          <div>
            <label htmlFor="bedrock-region" className="text-sm font-medium">
              AWS Region
            </label>
            <Select value={region} onValueChange={onRegionChange}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="Select a region" />
              </SelectTrigger>
              <SelectContent>
                {AWS_REGIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg">
            <ExternalLink className="w-4 h-4 text-blue-600" />
            <span className="text-sm text-blue-600">
              Need help?{" "}
              <button
                onClick={() =>
                  window.open(
                    "https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html",
                    "_blank",
                  )
                }
                className="underline hover:no-underline"
              >
                AWS Bedrock Docs
              </button>
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={
              !accessKeyId.trim() || !secretKey.trim() || !region.trim()
            }
          >
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
