# Claude manager

A Haiku-backed Claude that watches the other Claude sessions on this computer and serves a dashboard it designs itself.

* **Menu → Manager** starts/stops it and opens the dashboard.
* It reads `~/.claude/sessions` and transcript tails every 20 seconds without any model. Haiku runs only when something changed (at most every 3 minutes, `MANAGER_MIN_GAP_MS`) or when you message it.
* The dashboard listens on `127.0.0.1:<port + 1>` (`MANAGER_PORT`). Publish it: `tailscale serve --bg --https=10001 http://127.0.0.1:12701`.
* You can ask an agent to do something, answer one, or open its console, for sessions started in this server's terminals. Other sessions are read-only.
* The model's layout is a JSON tree limited to a fixed set of components; it is rendered as plain text, never HTML.
