"""A fictional orders MCP server whose tool calls reach MCPJam over OTLP.

Built on the official MCP Python SDK, which writes each call's span itself:
`mcp.method.name`, `gen_ai.tool.name`, `jsonrpc.request.id`, and `error.type`
for a JSON-RPC error or an `isError` result. The lab adds what the SDK does
not: the resource (service name, release, deployment environment), the
client's name and version, and, with `--outcomes on`, an `mcpjam.outcome`
span that reads the store itself rather than trusting the tool's answer.

    pip install mcp==2.3.0 opentelemetry-sdk==1.45.2 opentelemetry-exporter-otlp-proto-http==1.45.2
    MCPJAM_PRODUCER_TOKEN=mjotlp_... python orders_lab.py --release broken --outcomes on \\
        --otlp-endpoint https://<inspector>/api/v1/projects/<projectId>/otlp/v1/traces

The MCP endpoint is `/mcp`. Everything is fictional:

- `--release broken`: `refund_order` answers "refunded" and leaves the order paid.
- `--release fixed`: `refund_order` refunds the order.
- `--environment staging` marks a test copy, which MCPJam keeps out of counts.
- Order 9001 fails with a JSON-RPC error, order 9002 with an `isError` result,
  and an order id that isn't four digits is refused with -32602.

Run one process per client so trials never share orders. `GET /orders/<id>`
reads the store directly, for checking a verdict against the real state.
The producer credential is sent as a bearer and never printed.
"""

import argparse
import os
import re
import signal
import sys
from copy import deepcopy

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.shared.exceptions import MCPError
from mcp_types import INTERNAL_ERROR, INVALID_PARAMS
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import SpanKind
from starlette.requests import Request
from starlette.responses import JSONResponse

RELEASES = {"broken": "1.0.0-broken", "fixed": "1.0.1-fixed"}
FIXTURE = {
    "1042": {"customer": "Ada Park", "total": "54.20", "status": "paid"},
    "1043": {"customer": "Ravi Shah", "total": "18.00", "status": "paid"},
    "1044": {"customer": "Mia Chen", "total": "112.75", "status": "refunded"},
}
ORDER_ID = re.compile(r"[0-9]{4}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--otlp-endpoint", required=True)
    parser.add_argument("--release", choices=sorted(RELEASES), default="broken")
    parser.add_argument("--outcomes", choices=["on", "off"], default="on")
    parser.add_argument("--environment", default="production")
    parser.add_argument("--service-name", default="orders-lab")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def start_tracing(args: argparse.Namespace, token: str) -> TracerProvider:
    """Exports every span the SDK and the lab start, batched and gzipped."""
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": args.service_name,
                "service.version": RELEASES[args.release],
                "deployment.environment.name": args.environment,
            }
        )
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(
                endpoint=args.otlp_endpoint,
                headers={"Authorization": f"Bearer {token}"},
                compression=Compression.Gzip,
            )
        )
    )
    trace.set_tracer_provider(provider)
    return provider


def build_server(args: argparse.Namespace) -> MCPServer:
    orders = deepcopy(FIXTURE)
    tracer = trace.get_tracer("mcpjam-orders-lab")
    server = MCPServer(
        name="orders-lab",
        instructions="Fictional orders for testing. Call reset_orders before each trial.",
    )

    def label_client(ctx: Context) -> None:
        """Adds the client's name to the SDK's call span, which doesn't carry it."""
        params = ctx.session.client_params
        if params is not None:
            span = trace.get_current_span()
            span.set_attribute("mcp.client.name", params.client_info.name)
            span.set_attribute("mcp.client.version", params.client_info.version)

    def order(order_id: str) -> dict:
        if not ORDER_ID.fullmatch(order_id):
            raise MCPError(INVALID_PARAMS, "order_id must be a four-digit order number, such as 1042.")
        if order_id == "9001":
            raise MCPError(INTERNAL_ERROR, "The order service is unavailable. Retry in a minute.")
        if order_id == "9002":
            raise ToolError("Order 9002 is locked by another refund. Try again after it finishes.")
        if order_id not in orders:
            raise ToolError(f"There is no order {order_id}. Call list_orders to see the orders.")
        return orders[order_id]

    @server.tool()
    async def list_orders(ctx: Context) -> list[dict]:
        """Lists every order with its customer, total and status."""
        label_client(ctx)
        return [{"order_id": key, **value} for key, value in orders.items()]

    @server.tool()
    async def get_order(order_id: str, ctx: Context) -> dict:
        """Returns one order's customer, total and status."""
        label_client(ctx)
        return {"order_id": order_id, **order(order_id)}

    @server.tool()
    async def refund_order(order_id: str, reason: str, ctx: Context) -> dict:
        """Refunds a paid order in full."""
        label_client(ctx)
        record = order(order_id)
        if record["status"] != "paid":
            raise ToolError(f"Order {order_id} is {record['status']}, so it can't be refunded.")
        if args.release == "fixed":
            record["status"] = "refunded"
        if args.outcomes == "on":
            # Reads the store, not the answer below, as an independent check would.
            met = orders[order_id]["status"] == "refunded"
            with tracer.start_as_current_span(
                "mcpjam.outcome",
                kind=SpanKind.INTERNAL,
                attributes={
                    "mcpjam.outcome.name": "refund_committed",
                    "mcpjam.outcome.status": "met" if met else "not_met",
                },
            ):
                pass
        return {"order_id": order_id, "status": "refunded", "reason": reason}

    @server.tool()
    async def reset_orders(ctx: Context) -> dict:
        """Puts every order back to its starting state."""
        label_client(ctx)
        orders.clear()
        orders.update(deepcopy(FIXTURE))
        return {"reset": True, "orders": len(orders)}

    @server.custom_route("/orders", methods=["GET"])
    async def read_orders(_: Request) -> JSONResponse:
        return JSONResponse({"release": args.release, "orders": orders})

    @server.custom_route("/orders/{order_id}", methods=["GET"])
    async def read_order(request: Request) -> JSONResponse:
        record = orders.get(request.path_params["order_id"])
        return JSONResponse(record or {"error": "no such order"}, status_code=200 if record else 404)

    return server


def main() -> int:
    args = parse_args()
    token = os.environ.get("MCPJAM_PRODUCER_TOKEN", "")
    if not token:
        print("Set MCPJAM_PRODUCER_TOKEN to the project's producer credential.", file=sys.stderr)
        return 2
    provider = start_tracing(args, token)
    # uvicorn shuts down gracefully on SIGTERM, then raises it again under the
    # handler it found. Exiting here, rather than dying, lets the `finally`
    # below send the spans still batched.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        build_server(args).run(
            transport="streamable-http", host=args.host, port=args.port, json_response=True
        )
    finally:
        # Sends the spans still batched before the process exits.
        provider.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
