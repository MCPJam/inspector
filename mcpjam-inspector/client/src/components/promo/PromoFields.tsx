import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type { Ready } from "./promo-api";

type Props = {
  context: Ready;
  code: string;
  name: string;
  company: string;
  orgId: string;
  setCode: (value: string) => void;
  setName: (value: string) => void;
  setCompany: (value: string) => void;
  setOrgId: (value: string) => void;
};

export function PromoFields(props: Props) {
  const { context, orgId, setOrgId } = props;
  const fields = [
    {
      id: "name",
      label: "Full name",
      value: props.name,
      change: props.setName,
      max: 120,
      autoComplete: "name",
    },
    {
      id: "company",
      label: "Company",
      value: props.company,
      change: props.setCompany,
      max: 160,
      autoComplete: "organization",
    },
  ];
  return (
    <>
      <p className="text-sm ph-mask" data-sentry-mask>
        Signed in as {context.account.email}
      </p>
      {fields.map((field) => (
        <div key={field.id} className="space-y-2">
          <Label htmlFor={`promo-${field.id}`}>{field.label}</Label>
          <Input
            id={`promo-${field.id}`}
            className="ph-mask"
            data-sentry-mask
            placeholder={
              field.id === "company"
                ? "Company, Independent or Student"
                : "Your full name"
            }
            autoComplete={field.autoComplete}
            required
            maxLength={field.max}
            value={field.value}
            onChange={(event) => field.change(event.target.value)}
          />
        </div>
      ))}
      <div className="space-y-4 border-t border-border pt-4">
        <PromoCode code={props.code} setCode={props.setCode} />
        <PromoDestination context={context} orgId={orgId} setOrgId={setOrgId} />
      </div>
    </>
  );
}

function PromoDestination({
  context,
  orgId,
  setOrgId,
}: Pick<Props, "context" | "orgId" | "setOrgId">) {
  const [editing, setEditing] = useState(false);
  const org = context.organizations.find(
    (item) => item.organizationId === orgId,
  );
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm">Credits go to</p>
          <p className="mt-1 font-medium">{org?.name ?? "None available"}</p>
        </div>
        {context.organizations.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={editing}
            aria-controls="promo-destination"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Done" : "Change destination"}
          </Button>
        )}
      </div>
      {editing && (
        <div id="promo-destination" className="space-y-2">
          <Label htmlFor="promo-org">Organization</Label>
          <Select value={orgId} onValueChange={setOrgId} required>
            <SelectTrigger id="promo-org" className="w-full">
              <SelectValue placeholder="Choose an organization" />
            </SelectTrigger>
            <SelectContent>
              {context.organizations.map((item) => (
                <SelectItem
                  key={item.organizationId}
                  value={item.organizationId}
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {!context.organizations.length && (
        <p>
          You need to be an owner, admin or member of an organization.{" "}
          <a href="/organizations" className="underline">
            Manage organizations
          </a>
        </p>
      )}
    </div>
  );
}

function PromoCode({ code, setCode }: Pick<Props, "code" | "setCode">) {
  const [editing, setEditing] = useState(!code);
  return (
    <div className="space-y-2">
      {editing || !code ? (
        <>
          <Label htmlFor="promo-code">Code printed below the QR</Label>
          <Input
            id="promo-code"
            className="ph-mask"
            data-sentry-mask
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="off"
            maxLength={64}
            required
            placeholder="XXXXX-XXXXX"
            aria-describedby="promo-code-help"
          />
          <p id="promo-code-help" className="text-sm">
            On the back of your conference card.
          </p>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Code from your card</p>
            <p className="mt-1 font-mono text-sm ph-mask" data-sentry-mask>
              {code}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Change code
          </Button>
        </div>
      )}
    </div>
  );
}
