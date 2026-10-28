# Claude manager

A Haiku-backed Claude that watches the other Claude sessions on this computer and serves a dashboard it designs itself.

* **Menu → Manager** starts/stops it and opens the dashboard.
* It reads `~/.claude/sessions` and transcript tails every 20 seconds without any model. Haiku runs only when something changed (at most every 3 minutes, `MANAGER_MIN_GAP_MS`) or when you message it.
* The dashboard is reached at `/manager/` on the same address as the app (opening it starts the manager if needed). It also listens on `127.0.0.1:<port + 1>` (`MANAGER_PORT`), which you can publish on its own with `tailscale serve`; console links there need `?app=<app address>` once.
* You can ask an agent to do something, answer one, or open its console, for sessions started in this server's terminals. Other sessions are read-only.
* The model's layout is a JSON tree limited to a fixed set of components; it is rendered as plain text, never HTML.
