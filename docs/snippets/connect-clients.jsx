export const ConnectClients = () => {
  const [copied, setCopied] = useState(null);

  const chips = [
    {
      name: "Cursor",
      icon: "/images/clients/cursor_logo.png",
      href: "cursor://anysphere.cursor-deeplink/mcp/install?name=mcpjam&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtY3BqYW0vY2xpQGxhdGVzdCIsIm1jcCJdfQ==",
    },
    {
      name: "VS Code",
      icon: "/images/clients/vscode_logo.svg",
      href: "vscode:mcp/install?%7B%22name%22%3A%22mcpjam%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40mcpjam%2Fcli%40latest%22%2C%22mcp%22%5D%7D",
    },
    {
      name: "Claude Code",
      icon: "/images/clients/claude_code_logo.png",
      command: "claude mcp add mcpjam-local -- npx -y @mcpjam/cli@latest mcp",
    },
    {
      name: "Codex",
      icon: "/images/clients/codex-logo.svg",
      command: "codex mcp add mcpjam-local -- npx -y @mcpjam/cli@latest mcp",
    },
  ];

  const cards = [
    { name: "ChatGPT App", icon: "/images/clients/openai_logo.png", href: "https://chatgpt.com/plugins/plugin_asdk_app_6ae3a54df10c8191b901cbadc1d0df56" },
    { name: "Claude Connector", icon: "/images/clients/claude_logo.png", href: "/hosted/mcp-server" },
  ];

  const copy = (chip) => {
    const done = () => {
      setCopied(chip.name);
      setTimeout(() => setCopied(null), 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(chip.command).then(done, done);
    } else {
      done();
    }
  };

  const external = (
    <svg className="mcj-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );

  return (
    <div className="not-prose mcj-connect">
      <div className="mcj-chips">
        {chips.map((chip) =>
          chip.href ? (
            <a key={chip.name} className="mcj-chip" href={chip.href}>
              <img src={chip.icon} alt="" />
              <span>{chip.name}</span>
              {external}
            </a>
          ) : (
            <button key={chip.name} type="button" className="mcj-chip" aria-label={`Copy ${chip.name} command`} title={chip.command} onClick={() => copy(chip)}>
              <img src={chip.icon} alt="" />
              <span>{copied === chip.name ? "Command copied" : chip.name}</span>
            </button>
          )
        )}
      </div>
      <div className="mcj-cards">
        {cards.map((card) => (
          <a key={card.name} className="mcj-card" href={card.href} {...(card.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
            {external}
            <div className="mcj-card-icons">
              <img className="mcj-card-client" src={card.icon} alt="" />
              <span className="mcj-card-app">
                <img src="/images/clients/mcpjam.svg" alt="MCPJam" />
              </span>
            </div>
            <span className="mcj-card-name">{card.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
};
