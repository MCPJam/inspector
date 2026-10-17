/** Commands issued through the real native tool in each platform's shell. */
export function codexConformanceCommands(args: {
  platform: NodeJS.Platform;
  outsidePath: string;
  gatewayPort: number;
  upstreamKeyCanary: string;
}) {
  if (args.platform === "win32") {
    const outside = `'${args.outsidePath.replace(/'/g, "''")}'`;
    return {
      read: "Get-Content hello.txt",
      marker:
        '[IO.File]::AppendAllText((Join-Path (Get-Location) "attended-off-marker.txt"), "run`n")',
      inside: "Set-Content inside.txt inside; 'WROTE_INSIDE'",
      tmpdir:
        "Set-Content (Join-Path $env:TMPDIR private.txt) private; Get-Content (Join-Path $env:TMPDIR private.txt); 'TMPDIR_OK'",
      outside: `try { Set-Content -LiteralPath ${outside} outside -ErrorAction Stop; 'EXIT=0' } catch { 'EXIT=1' }`,
      network: `try { $c = [Net.Sockets.TcpClient]::new(); if ($c.ConnectAsync('127.0.0.1', ${args.gatewayPort}).Wait(2000)) { 'NET_OPEN' } else { 'NET_BLOCKED' } } catch { 'NET_BLOCKED' } finally { $c.Dispose() }`,
      environment: `if (Get-ChildItem Env: | Where-Object { $_.Value -eq '${args.upstreamKeyCanary}' }) { 'UPSTREAM_KEY_LEAK' } else { 'NO_UPSTREAM_KEY' }`,
    };
  }
  return {
    read: "cat hello.txt",
    marker: "printf 'run\\n' >> attended-off-marker.txt",
    inside: "echo inside > inside.txt && echo WROTE_INSIDE",
    tmpdir:
      'echo private > "$TMPDIR/private.txt" && cat "$TMPDIR/private.txt" && echo TMPDIR_OK',
    outside: `echo outside > ${JSON.stringify(args.outsidePath)}; echo EXIT=$?`,
    network: `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${args.gatewayPort} && echo NET_OPEN || echo NET_BLOCKED'`,
    environment: "",
  };
}
