export const ConnectClients = () => {
  const [copied, setCopied] = useState(null);
  const [open, setOpen] = useState(null);

  const serverJson = (key) =>
    JSON.stringify(
      { [key]: { mcpjam: { command: "npx", args: ["-y", "@mcpjam/cli@latest", "mcp"] } } },
      null,
      2
    );

  const chips = [
    {
      name: "Claude Code",
      icon: "/images/clients/claude_code_logo.png",
      command: "claude mcp add mcpjam-local -- npx -y @mcpjam/cli@latest mcp",
      help: "Command copied. Paste it into your terminal and press Enter. If the copy didn't work, copy it from here:",
    },
    {
      name: "Codex",
      icon: "/images/clients/codex-logo.svg",
      command: "codex mcp add mcpjam-local -- npx -y @mcpjam/cli@latest mcp",
      help: "Command copied. Paste it into your terminal and press Enter. If the copy didn't work, copy it from here:",
    },
    {
      name: "Cursor",
      icon: "/images/clients/cursor_logo.png",
      href: "cursor://anysphere.cursor-deeplink/mcp/install?name=mcpjam&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtY3BqYW0vY2xpQGxhdGVzdCIsIm1jcCJdfQ==",
      help: "Cursor should open an Install MCP server dialog; click Install. If nothing opened, add this to ~/.cursor/mcp.json (all projects) or .cursor/mcp.json (this project), then restart Cursor:",
      snippet: serverJson("mcpServers"),
    },
    {
      name: "VS Code",
      icon: "/images/clients/vscode_logo.svg",
      href: "vscode:mcp/install?%7B%22name%22%3A%22mcpjam%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mcpjam%2Fcli%40latest%22%2C%22mcp%22%5D%7D",
      help: "VS Code should open an install page for the server; click Install. If nothing opened, add this to .vscode/mcp.json in your workspace, then start the server from that file:",
      snippet: serverJson("servers"),
    },
  ];

  const cards = [
    {
      name: "ChatGPT & Codex",
      icons: ["/images/clients/openai_logo.png", "/images/clients/codex-logo.svg"],
      href: "https://chatgpt.com/plugins/plugin_asdk_app_6ae3a54df10c8191b901cbadc1d0df56",
      desktopHref: "https://chatgpt.com/plugins/plugin_asdk_app_6ae3a54df10c8191b901cbadc1d0df56?open_in_app",
    },
  ];

  const writeClipboard = (text, key) => {
    const done = () => {
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      done();
    }
  };

  const select = (chip) => {
    setOpen(chip.name);
    if (chip.command) writeClipboard(chip.command, chip.name);
  };

  const external = (
    <svg className="mcj-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );

  const active = chips.find((chip) => chip.name === open);
  const activeText = active ? active.snippet || active.command : "";

  return (
    <div className="not-prose mcj-connect">
      <div className="mcj-chips">
        {chips.map((chip) =>
          chip.href ? (
            <a key={chip.name} className="mcj-chip" href={chip.href} aria-expanded={open === chip.name} aria-controls="mcj-help" onClick={() => select(chip)}>
              <img src={chip.icon} alt="" />
              <span>{chip.name}</span>
              {external}
            </a>
          ) : (
            <button key={chip.name} type="button" className="mcj-chip" aria-label={`Copy ${chip.name} command`} aria-expanded={open === chip.name} aria-controls="mcj-help" title={chip.command} onClick={() => select(chip)}>
              <img src={chip.icon} alt="" />
              <span>{copied === chip.name ? "Command copied" : chip.name}</span>
            </button>
          )
        )}
      </div>
      {active ? (
        <div id="mcj-help" className="mcj-help" role="region" aria-label={`${active.name} setup`}>
          <div className="mcj-help-head">
            <img src={active.icon} alt="" />
            <span>{active.name}</span>
            <button type="button" className="mcj-help-close" aria-label="Close setup help" onClick={() => setOpen(null)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <p className="mcj-help-text">{active.help}</p>
          <div className="mcj-help-code">
            <pre><code>{activeText}</code></pre>
            <button type="button" className="mcj-help-copy" onClick={() => writeClipboard(activeText, `${active.name}-panel`)}>
              {copied === `${active.name}-panel` ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mcj-help-text">
            More options are in <a href="/installation#add-mcpjam-to-your-coding-agent">Installation</a>.
          </p>
        </div>
      ) : null}
      <div className="mcj-cards">
        {cards.map((card) => (
          <div key={card.name} className="mcj-card">
            {external}
            <div className="mcj-card-icons">
              {card.icons.map((icon) => (
                <img key={icon} className="mcj-card-client" src={icon} alt="" />
              ))}
              <span className="mcj-card-app">
                <img src="/images/clients/mcpjam.svg" alt="MCPJam" />
              </span>
            </div>
            <a className="mcj-card-name mcj-card-main" href={card.href} target="_blank" rel="noopener noreferrer">{card.name}</a>
            {card.desktopHref ? (
              <a className="mcj-card-alt" href={card.desktopHref} target="_blank" rel="noopener noreferrer">Open in the desktop app</a>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};
