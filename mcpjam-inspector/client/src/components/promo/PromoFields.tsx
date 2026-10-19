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
    },
    {
      id: "company",
      label: "Company",
      value: props.company,
      change: props.setCompany,
      max: 160,
    },
    {
      id: "code",
      label: "Card code",
      value: props.code,
      change: props.setCode,
      max: 64,
    },
  ];
  return (
    <>
      {fields.map((field) => (
        <div key={field.id} className="space-y-2">
          <Label htmlFor={`promo-${field.id}`}>{field.label}</Label>
          <Input
            id={`promo-${field.id}`}
            className="h-11 bg-background ph-mask"
            data-sentry-mask
            placeholder={
              field.id === "code"
                ? "XXXXX-XXXXX"
                : field.id === "company"
                  ? "Company, Independent or Student"
                  : "Your full name"
            }
            required
            maxLength={field.max}
            value={field.value}
            onChange={(event) => field.change(event.target.value)}
          />
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor="promo-email">Account email</Label>
        <Input
          id="promo-email"
          className="h-11 bg-background ph-mask"
          data-sentry-mask
          value={context.account.email}
          readOnly
        />
      </div>
      <PromoDestination context={context} orgId={orgId} setOrgId={setOrgId} />
    </>
  );
}

function PromoDestination({
  context,
  orgId,
  setOrgId,
}: Pick<Props, "context" | "orgId" | "setOrgId">) {
  return (
    <>
      {context.organizations.length > 1 ? (
        <div className="space-y-2">
          <Label htmlFor="promo-org">Receiving organization</Label>
          <select
            id="promo-org"
            className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={orgId}
            required
            onChange={(event) => setOrgId(event.target.value)}
          >
            <option value="">Choose an organization</option>
            {context.organizations.map((org) => (
              <option key={org.organizationId} value={org.organizationId}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p>
          Receiving organization:{" "}
          {context.organizations[0]?.name ?? "None available"}
        </p>
      )}
      {!context.organizations.length && (
        <p>
          You need to be an owner, admin or member of an organization.{" "}
          <a href="/organizations" className="underline">
            Manage organizations
          </a>
        </p>
      )}
    </>
  );
}
