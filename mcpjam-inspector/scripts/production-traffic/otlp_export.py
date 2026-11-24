"""Send one fictional MCP tool call and its outcome to an MCPJam OTLP receiver.

Uses the official OpenTelemetry Python SDK and its OTLP/HTTP protobuf
exporter, so the receiver sees the bytes a real Python MCP server sends.
The producer credential comes from MCPJAM_PRODUCER_TOKEN and is never
printed. Prints the ids it sent as JSON and exits 0 only if the export
succeeded.

    pip install opentelemetry-sdk==1.45.2 opentelemetry-exporter-otlp-proto-http==1.45.2
    MCPJAM_PRODUCER_TOKEN=mjotlp_... python otlp_export.py \\
        --endpoint https://<inspector>/api/v1/projects/<projectId>/otlp/v1/traces
"""

import argparse
import json
import os
import sys

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--service-name", default="orders-lab-python")
    parser.add_argument("--service-version", default="1.0.0-broken")
    parser.add_argument("--environment", default="production")
    parser.add_argument("--client-name", default="claude-code")
    parser.add_argument("--outcome", choices=["met", "not_met"], default="not_met")
    parser.add_argument("--gzip", action="store_true")
    args = parser.parse_args()

    token = os.environ.get("MCPJAM_PRODUCER_TOKEN", "")
    if not token:
        print("Set MCPJAM_PRODUCER_TOKEN to the project's producer credential.", file=sys.stderr)
        return 2

    memory = InMemorySpanExporter()
    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": args.service_name,
                "service.version": args.service_version,
                "deployment.environment.name": args.environment,
            }
        )
    )
    provider.add_span_processor(SimpleSpanProcessor(memory))
    tracer = provider.get_tracer("mcpjam-production-traffic-fixture")

    with tracer.start_as_current_span(
        "tools/call refund_order",
        kind=SpanKind.SERVER,
        attributes={
            "mcp.method.name": "tools/call",
            "gen_ai.tool.name": "refund_order",
            "mcp.protocol.version": "2025-11-25",
            "jsonrpc.request.id": 7,
            "mcp.client.name": args.client_name,
            "mcp.client.version": "2.1.0",
            # Fictional content: the receiver must not store it while the
            # project keeps metadata only.
            "gen_ai.tool.call.arguments": '{"order_id": "1042"}',
            "gen_ai.tool.call.result": '{"content": [{"type": "text", "text": "Refund issued"}]}',
        },
    ) as call:
        call_context = call.get_span_context()

    with tracer.start_as_current_span(
        "mcpjam.outcome",
        context=trace.set_span_in_context(trace.NonRecordingSpan(call_context)),
        attributes={
            "mcpjam.outcome.name": "refund_committed",
            "mcpjam.outcome.status": args.outcome,
        },
    ) as outcome:
        outcome_context = outcome.get_span_context()

    exporter = OTLPSpanExporter(
        endpoint=args.endpoint,
        headers={"Authorization": f"Bearer {token}"},
        compression=Compression.Gzip if args.gzip else Compression.NoCompression,
        timeout=15,
    )
    result = exporter.export(memory.get_finished_spans())
    exporter.shutdown()
    print(
        json.dumps(
            {
                "export": result.name,
                "traceId": format(call_context.trace_id, "032x"),
                "callSpanId": format(call_context.span_id, "016x"),
                "outcomeSpanId": format(outcome_context.span_id, "016x"),
                "serviceName": args.service_name,
            }
        )
    )
    return 0 if result == SpanExportResult.SUCCESS else 1


if __name__ == "__main__":
    sys.exit(main())
