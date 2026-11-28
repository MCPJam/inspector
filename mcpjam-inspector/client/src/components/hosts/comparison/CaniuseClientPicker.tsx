import { useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@mcpjam/design-system/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
import type { HostComparisonSubject } from "@/lib/host-config-field-schema";
import { orderPublicClients, publicClientIdentity } from "./caniuse-coverage";
import { clientLogo } from "./CaniuseSite";

export function CaniuseClientPicker({
  clients,
  selected,
  onChange,
}: {
  clients: readonly HostComparisonSubject[];
  selected: readonly HostComparisonSubject[];
  onChange: (ids: string[]) => void;
}) {
  const [picker, setPicker] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const ids = selected.map(({ hostId }) => hostId);
  const hasAvailableClients = clients.some(({ hostId }) => !ids.includes(hostId));
  const groups = new Map<string, HostComparisonSubject[]>();
  for (const client of orderPublicClients(clients)) {
    const { surface } = publicClientIdentity(client);
    const group = groups.get(surface) ?? [];
    group.push(client);
    groups.set(surface, group);
  }

  function select(id: string) {
    if (id === picker) {
      setPicker(null);
      return;
    }
    onChange(
      picker === "add"
        ? [...ids, id]
        : ids.map((previous) => (previous === picker ? id : previous)),
    );
    setPicker(null);
  }

  return (
    <Dialog
      open={picker !== null}
      onOpenChange={(open) => {
        if (!open) setPicker(null);
      }}
    >
      <div className="mb-5 flex min-h-[47px] items-stretch gap-2 sm:min-h-[57px]">
        {selected.length > 0 && (
          <div className="caniuse-client-strip flex min-w-0 flex-1 flex-nowrap gap-2 overflow-x-auto rounded-md">
            {selected.map((client) => (
              <div
                key={client.hostId}
                className="flex min-w-44 flex-1 shrink-0 items-center rounded-lg border border-border bg-card text-card-foreground"
              >
                <Button
                  variant="ghost"
                  disabled={!hasAvailableClients}
                  className="h-full min-w-0 flex-1 justify-start gap-1.5 px-2 py-1 text-left text-[13px] leading-[1.35] sm:gap-2 sm:px-2.5 sm:py-2"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setPicker(client.hostId);
                  }}
                  aria-label={`Replace ${client.hostName}`}
                >
                  <img
                    src={clientLogo(client)}
                    alt=""
                    className="size-7 shrink-0 rounded object-contain"
                  />
                  <span className="min-w-0 flex-1 font-semibold">
                    <span className="block whitespace-normal wrap-break-word">
                      {client.hostName}
                    </span>
                    <span className="rounded bg-muted px-1 text-[11px] font-medium text-muted-foreground">
                      {publicClientIdentity(client).surface}
                    </span>
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground sm:mr-1"
                  aria-label={`Remove ${client.hostName}`}
                  onClick={() =>
                    onChange(ids.filter((id) => id !== client.hostId))
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <DialogTrigger asChild>
          <Button
            disabled={!hasAvailableClients}
            onClick={() => {
              opener.current = null;
              setPicker("add");
            }}
            className="h-auto shrink-0 px-2.5 text-[13px] font-bold sm:px-4"
          >
            <Plus className="size-4" /> Add client
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent
        className="dark caniuse-dialog gap-4 border-0 text-foreground"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          if (opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
      >
        <DialogTitle>
          {picker === "add" ? "Add client" : "Replace client"}
        </DialogTitle>
        <Command className="bg-transparent text-foreground">
          <CommandInput placeholder="Search clients or surfaces" />
          <CommandList className="scroll-fade-y max-h-[min(360px,55dvh)] scroll-py-5 [--scroll-fade-reveal:24px] [--scroll-fade-size:16px]">
            <CommandEmpty>No matching clients.</CommandEmpty>
            {[...groups].map(([surface, options]) => (
              <CommandGroup key={surface} heading={surface}>
                {options.map((client) => {
                  const status =
                    picker === client.hostId
                      ? "Current"
                      : ids.includes(client.hostId)
                        ? "Comparing"
                        : null;
                  return (
                    <CommandItem
                      key={client.hostId}
                      value={client.hostId}
                      keywords={[
                        client.hostName,
                        surface,
                        publicClientIdentity(client).mode,
                      ]}
                      onSelect={() => select(client.hostId)}
                      disabled={status === "Comparing"}
                      className="gap-3 py-2 data-[disabled=true]:opacity-60"
                    >
                      <img
                        src={clientLogo(client)}
                        alt=""
                        className="size-9 shrink-0 rounded-md border border-border bg-card object-contain p-1"
                      />
                      <span className="min-w-0 flex-1 font-semibold">
                        {client.hostName}
                      </span>
                      {status && (
                        <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                          {status}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
