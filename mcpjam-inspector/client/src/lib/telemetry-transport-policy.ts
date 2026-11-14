// A tiny SDK-free bridge lets the transport install before SDK imports.
let reader: () => "strict" | "full" = () => "strict";
export function setTelemetryTransportPolicyReader(value: typeof reader): void { reader = value; }
export function liveTelemetryContentPolicy(): "strict" | "full" { return reader(); }
