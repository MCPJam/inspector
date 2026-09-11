import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@mcpjam/design-system/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { HoverCard, HoverCardContent } from "@mcpjam/design-system/hover-card";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@mcpjam/design-system/menubar";
import { Popover, PopoverContent } from "@mcpjam/design-system/popover";
import {
  Select,
  SelectContent,
  SelectItem,
} from "@mcpjam/design-system/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { Tooltip, TooltipContent } from "@mcpjam/design-system/tooltip";

// Browser translators rewrite text nodes in-place. React then cannot remove
// the portaled surface it still has a reference to, and the whole app falls
// through to the route error screen. See Sentry INSPECTOR-CLIENT-27X.
function expectOptedOutOfTranslation(slot: string) {
  const element = document.querySelector(`[data-slot="${slot}"]`);
  expect(
    element,
    `no element rendered for [data-slot="${slot}"]`,
  ).not.toBeNull();
  expect(element).toHaveAttribute("translate", "no");
  expect(element).toHaveClass("notranslate");
}

describe("portaled design-system surfaces opt out of browser translation", () => {
  it("marks dialog content", () => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    expectOptedOutOfTranslation("dialog-content");
  });

  it("marks alert dialog content", () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Title</AlertDialogTitle>
          <AlertDialogDescription>Description</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>,
    );

    expectOptedOutOfTranslation("alert-dialog-content");
  });

  it("marks sheet content", () => {
    render(
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>Title</SheetTitle>
          <SheetDescription>Description</SheetDescription>
        </SheetContent>
      </Sheet>,
    );

    expectOptedOutOfTranslation("sheet-content");
  });

  it("marks popover content", () => {
    render(
      <Popover defaultOpen>
        <PopoverContent>Body</PopoverContent>
      </Popover>,
    );

    expectOptedOutOfTranslation("popover-content");
  });

  it("marks dropdown menu content", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expectOptedOutOfTranslation("dropdown-menu-content");
  });

  it("marks select content", () => {
    render(
      <Select defaultOpen>
        <SelectContent>
          <SelectItem value="a">A</SelectItem>
        </SelectContent>
      </Select>,
    );

    expectOptedOutOfTranslation("select-content");
  });

  it("marks tooltip content", () => {
    render(
      <Tooltip defaultOpen>
        <TooltipContent>Hint</TooltipContent>
      </Tooltip>,
    );

    expectOptedOutOfTranslation("tooltip-content");
  });

  it("marks hover card content", () => {
    render(
      <HoverCard defaultOpen>
        <HoverCardContent>Body</HoverCardContent>
      </HoverCard>,
    );

    expectOptedOutOfTranslation("hover-card-content");
  });

  it("marks context menu content", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("Target"));

    expectOptedOutOfTranslation("context-menu-content");
  });

  it("marks menubar content", () => {
    render(
      <Menubar defaultValue="file">
        <MenubarMenu value="file">
          <MenubarContent>
            <MenubarItem>Item</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>,
    );

    expectOptedOutOfTranslation("menubar-content");
  });
  it("marks dropdown menu sub content", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.click(screen.getByText("More"));

    expectOptedOutOfTranslation("dropdown-menu-sub-content");
  });

  it("marks context menu sub content", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>Target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Item</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("Target"));
    fireEvent.click(screen.getByText("More"));

    expectOptedOutOfTranslation("context-menu-sub-content");
  });

  it("marks menubar sub content", () => {
    render(
      <Menubar defaultValue="file">
        <MenubarMenu value="file">
          <MenubarContent>
            <MenubarSub>
              <MenubarSubTrigger>More</MenubarSubTrigger>
              <MenubarSubContent>
                <MenubarItem>Item</MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>,
    );
    fireEvent.click(screen.getByText("More"));

    expectOptedOutOfTranslation("menubar-sub-content");
  });
});
