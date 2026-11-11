# Claude manager

A Haiku-backed Claude that watches the other Claude sessions on this computer and serves a dashboard it designs itself.

* **Menu → Manager** starts/stops it and opens the dashboard.
* It reads `~/.claude/sessions` and transcript tails every 20 seconds without any model. Haiku runs only when something changed (at most every 3 minutes, `MANAGER_MIN_GAP_MS`) or when you message it.
* The dashboard is reached at `/manager/` on the same address as the app (opening it starts the manager if needed). It also listens on `127.0.0.1:<port + 1>` (`MANAGER_PORT`), which you can publish on its own with `tailscale serve`; console links there need `?app=<app address>` once.
* Every agent has a mini chat page (**Chat** on its card, `#/a/<id>`): a summary of where it stands, then you send it a message and watch progress notes that collapse into one final summary. Agents started in this server's terminals get the text typed in and have **Open terminal** (top right) and **Stop agent**. Other sessions are messaged through Claude's peer messaging; they can't be opened or stopped from here.
* The layout is designed by the manager following `server/manager-skill.md` (it receives per-agent summaries); edit that file to change how the dashboard is composed.
* The model's layout is a JSON tree limited to a fixed set of components; it is rendered as plain text, never HTML.

## Web consoles

Any agent can publish a small web page to the home screen. It writes
`~/.remote-terminal-server/consoles/<name>.json` with `{"name", "port", "description", "pid"}`; while that
`pid` is alive the console is listed under **Web consoles** and served at `/c/<name>/` (plain HTTP and SSE;
use relative URLs). The Claude Manager is itself listed there and is a singleton: its Start button opens the
one dashboard instead of creating another.

The dashboard's **⋯** menu has **Tell agents about web consoles**, which types a one-line pointer to
`~/.remote-terminal-server/AGENT_GUIDE.md` into each idle agent running in a Remote Terminal. The guide
is regenerated from `server/agent-guide.md` at every server start.

## Next moves on the board

Every session card shows what the agent is doing, any blocker, and three suggested next moves. Tap one to
send it to that agent, or type your own instruction in the card's box. Briefs are made in the background
(about once a minute, and only for agents whose transcript changed), so you do not need to open each chat.

- **Keep all going** (top bar) sends each idle agent its top suggested move.
- **Tell all idle agents…** (bottom box) sends one message to every idle agent. Busy or waiting agents are
  skipped, because typing into them would mangle their prompt.
- **⋯ → About & version** shows the running version and the latest one, and whether you are up to date.
