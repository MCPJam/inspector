/**
 * Candidate directions to another tool.
 *
 * The held-out cases below were written after the patterns and were not used
 * to tune them: invented tool descriptions from unrelated domains, worded the
 * way people write them. The test names record what the detector measured on
 * them, misses included, so a change to the patterns shows up as a change in
 * those numbers.
 */

import { describe, expect, it } from "vitest";

import {
  findToolDirectionCandidates,
  type ToolTextEvidence,
} from "../../src/directory-readiness/tool-directions.js";

interface Case {
  id: string;
  /** The tool whose text holds the sentence. */
  tool: string;
  /** Put the text in this parameter's description instead of the tool's. */
  param?: string;
  text: string;
}

/** Sentences that tell the model to call, or to order calls of, another tool. */
const HELD_OUT_DIRECTIONS: Case[] = [
  {
    id: "P1",
    tool: "update_contact",
    text: "Before changing a contact, fetch its current fields with get_contact so nothing is overwritten.",
  },
  {
    id: "P2",
    tool: "write_file",
    param: "path",
    text: "Absolute path. Run list_directory first if you are not sure the folder exists.",
  },
  {
    id: "P3",
    tool: "refund_charge",
    text: "Never use this tool unless lookup_charge has confirmed the charge settled.",
  },
  {
    id: "P4",
    tool: "create_event",
    text: "Check attendee availability with find_free_slots before booking anything.",
  },
  {
    id: "P5",
    tool: "deploy_build",
    text: "Call this only after run_tests reports success.",
  },
  {
    id: "P6",
    tool: "summarize_doc",
    param: "document_id",
    text: "Pass an id you got from search_documents.",
  },
  {
    id: "P7",
    tool: "run_report",
    text: "Reports can take minutes, so keep polling report_status until it says done.",
  },
  {
    id: "P8",
    tool: "send_message",
    text: "If the channel name is ambiguous, resolve it via lookup_channel first.",
  },
  {
    id: "P9",
    tool: "get_directions",
    text: "Geocode both addresses with geocode_address and then call this tool with the coordinates.",
  },
  {
    id: "P10",
    tool: "reserve_stock",
    text: "You should confirm quantities using check_inventory beforehand.",
  },
  {
    id: "P11",
    tool: "merge_branch",
    text: "Make sure to run fetch_remote before merging so the branch is current.",
  },
  {
    id: "P12",
    tool: "export_table",
    text: "For large tables, prefer stream_rows instead.",
  },
  {
    id: "P13",
    tool: "close_ticket",
    text: "Once the ticket is closed, follow up with notify_requester.",
  },
  {
    id: "P14",
    tool: "query_db",
    param: "sql",
    text: "SQL to run. Inspect the schema using describe_table before writing joins.",
  },
  {
    id: "P15",
    tool: "start_training",
    text: "This tool returns a job id; poll get_training_status every 30 seconds to track progress.",
  },
  {
    id: "P16",
    tool: "upload_part",
    text: "After the last part, finish the upload by calling complete_upload.",
  },
  {
    id: "P17",
    tool: "charge_card",
    text: "tokenize_card must be called first to obtain a payment token.",
  },
  {
    id: "P18",
    tool: "delete_user",
    text: "Do not invoke this without first calling export_user_data.",
  },
  {
    id: "P19",
    tool: "translate_text",
    text: "Detect the language with detect_language when the source is unknown.",
  },
  {
    id: "P20",
    tool: "book_meeting",
    text: "Always look up the user's timezone with get_user_profile.",
  },
];

/** Sentences that name another tool as a plain fact. */
const HELD_OUT_BENIGN: Case[] = [
  {
    id: "B1",
    tool: "get_order",
    text: "Returns the same fields as list_orders, plus line items.",
  },
  {
    id: "B2",
    tool: "archive_project",
    text: "Archived projects no longer appear in list_projects.",
  },
  {
    id: "B3",
    tool: "get_invoice",
    param: "invoice_id",
    text: "Invoice id, as returned by create_invoice.",
  },
  {
    id: "B4",
    tool: "search_docs",
    text: "Results are ranked like those of search_web.",
  },
  {
    id: "B5",
    tool: "restore_file",
    text: "Unlike delete_file, this action can be undone.",
  },
  {
    id: "B6",
    tool: "rename_label",
    text: "Labels created by create_label can be renamed here.",
  },
  {
    id: "B7",
    tool: "sync_calendar",
    text: "This runs automatically every hour; manual_sync triggers the same job on demand.",
  },
  {
    id: "B8",
    tool: "get_weather",
    text: "Covers the same regions as get_forecast.",
  },
  {
    id: "B9",
    tool: "list_members",
    text: "Each member id can be passed to remove_member or update_role.",
  },
  {
    id: "B10",
    tool: "create_payment",
    text: "Payments made here show up in list_transactions within a minute.",
  },
  {
    id: "B11",
    tool: "read_config",
    text: "Mirrors the format that write_config accepts.",
  },
  {
    id: "B12",
    tool: "get_profile",
    param: "user_id",
    text: "The same identifier used by get_user.",
  },
  {
    id: "B13",
    tool: "cancel_order",
    text: "Orders shipped through ship_order cannot be cancelled.",
  },
  {
    id: "B14",
    tool: "count_rows",
    text: "Faster than query_table for simple counts.",
  },
  {
    id: "B15",
    tool: "list_repos",
    text: "Repositories forked with fork_repo are included.",
  },
  {
    id: "B16",
    tool: "get_status",
    text: "Status values match the ones set by update_status.",
  },
  {
    id: "B17",
    tool: "fetch_page",
    text: "The deprecated scrape_page tool did the same thing with less control.",
  },
  {
    id: "B18",
    tool: "export_report",
    text: "Exports use the template configured in set_template.",
  },
  {
    id: "B19",
    tool: "delete_comment",
    text: "Only comments posted with post_comment can be deleted.",
  },
  {
    id: "B20",
    tool: "move_card",
    text: "Cards keep the labels that add_label attached.",
  },
];

/** One listing holding every case, plus a bare entry for each tool they name. */
function listingOf(cases: readonly Case[]): ToolTextEvidence[] {
  const owners = cases.map(({ tool, param, text }): ToolTextEvidence =>
    param
      ? {
          name: tool,
          description: "Does its own work.",
          inputSchema: {
            type: "object",
            properties: { [param]: { type: "string", description: text } },
          },
        }
      : { name: tool, description: text }
  );
  const named = new Set(owners.map((owner) => owner.name));
  const mentioned = cases
    .flatMap(({ text }) => text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
    .filter((name) => !named.has(name) && named.add(name) !== undefined);
  return [...owners, ...mentioned.map((name) => ({ name }))];
}

function flaggedIds(cases: readonly Case[]): string[] {
  const flagged = new Set(
    findToolDirectionCandidates(listingOf(cases)).map(
      (candidate) => candidate.tool
    )
  );
  return cases.filter((entry) => flagged.has(entry.tool)).map(({ id }) => id);
}

describe("held-out cases", () => {
  it("finds 17 of 20 held-out directions; misses P9, P16 and P19", () => {
    const found = flaggedIds(HELD_OUT_DIRECTIONS);
    expect(
      HELD_OUT_DIRECTIONS.map(({ id }) => id).filter(
        (id) => !found.includes(id)
      )
    ).toEqual(["P9", "P16", "P19"]);
  });

  it("flags 0 of 20 held-out benign references", () => {
    expect(flaggedIds(HELD_OUT_BENIGN)).toEqual([]);
  });
});

describe("the shapes the brief names", () => {
  const listing: ToolTextEvidence[] = [
    "list_orders",
    "get_user",
    "create_order",
    "list_projects",
    "get_item",
    "get_details",
    "get_job_status",
    "get_context",
    "delete_item",
  ].map((name) => ({ name }));
  const flagged = (text: string) =>
    findToolDirectionCandidates([
      ...listing,
      { name: "under_test", description: text },
    ]).map((candidate) => candidate.quote);

  it.each([
    "Use this before list_orders.",
    "Use it with get_user to show names.",
    "Use after create_order completes.",
    "Call list_projects first to get a project id.",
    "Search the catalog, then call get_item with the id.",
    "Follow with get_details for the full record.",
    "Poll get_job_status until it reports done.",
    "Always call get_context before answering.",
    "Do not call delete_item unless the user has confirmed.",
  ])("proposes %j", (text) => {
    expect(flagged(text)).toEqual([text]);
  });

  it.each([
    "Returns the same fields as get_item.",
    "Equivalent to calling list_orders with no filter.",
    "Results are cached by get_context.",
    "Use the same filters as list_orders.",
    "See also get_details.",
  ])("leaves %j alone", (text) => {
    expect(flagged(text)).toEqual([]);
  });
});

describe("what a candidate carries", () => {
  it("quotes the sentence verbatim, with its tool and field", () => {
    const text =
      "Order filter. Values come from list_statuses. Call list_statuses first, e.g. when unsure.";
    const [candidate, ...rest] = findToolDirectionCandidates([
      { name: "list_statuses" },
      {
        name: "find_orders",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "object",
              properties: { status: { type: "string", description: text } },
            },
          },
        },
      },
    ]);
    expect(rest).toEqual([]);
    expect(candidate).toEqual({
      tool: "find_orders",
      field: "inputSchema.properties.filter.properties.status.description",
      quote: "Call list_statuses first, e.g. when unsure.",
      references: ["list_statuses"],
    });
    expect(text).toContain(candidate.quote);
  });

  it("reads array items and lists every tool a sentence names", () => {
    const [candidate] = findToolDirectionCandidates([
      { name: "orders.list" },
      { name: "orders-get" },
      {
        name: "bulk_update",
        inputSchema: {
          type: "object",
          properties: {
            ids: {
              type: "array",
              items: {
                type: "string",
                description:
                  "Use ids from `orders.list`, then call orders-get to check each one.",
              },
            },
          },
        },
      },
    ]);
    expect(candidate.field).toBe(
      "inputSchema.properties.ids.items.description"
    );
    expect(candidate.references).toEqual(["orders.list", "orders-get"]);
  });

  it("ignores a tool's directions about itself", () => {
    expect(
      findToolDirectionCandidates([
        {
          name: "get_status",
          description: "Call get_status again in a minute.",
        },
      ])
    ).toEqual([]);
  });

  it("reads a plain-word name as a tool only when quoted or called a tool", () => {
    const scan = (description: string) =>
      findToolDirectionCandidates([
        { name: "search" },
        { name: "fetch", description },
      ]);
    expect(scan("Use search to find the id first.")).toEqual([]);
    expect(scan("Use `search` to find the id first.")).toHaveLength(1);
    expect(scan("Use the search tool to find the id first.")).toHaveLength(1);
  });

  it("quotes a long sentence around the direction, still verbatim", () => {
    const description = `${"This tool reads the ledger in pages ".repeat(20)}and you should call close_ledger once the last page is read`;
    const [candidate] = findToolDirectionCandidates([
      { name: "close_ledger" },
      { name: "read_ledger", description },
    ]);
    expect(candidate.quote.length).toBeLessThanOrEqual(400);
    expect(description).toContain(candidate.quote);
    expect(candidate.quote).toContain("call close_ledger");
  });
});
