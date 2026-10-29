# Remote Terminal: what you can do from here

You are running on a computer that has Remote Terminal. Its home page (over Tailscale) lists the
terminals and the **web consoles** that agents like you publish. A person on a phone opens them from there.

## Publish a web console (e.g. a 3D viewer, a dashboard, a log tail)
1. Serve a plain HTTP page on `127.0.0.1:<port>` (pick a free port above 1024, not 12700 or 12701).
   It is shown at `/c/<name>/`, so use **relative URLs** (`app.js`, not `/app.js`) and relative `fetch`/`EventSource` paths.
   Plain HTTP and SSE work; WebSockets are not proxied.
2. Register it by writing `~/.remote-terminal-server/consoles/<name>.json`:
   `{"name": "3d-viewer", "port": 8123, "description": "Model viewer for the invoice PCB", "pid": <your server's pid>}`
   - `name`: lowercase letters, digits, dashes (max 40). `pid`: when that process ends, the console disappears.
3. It now appears under **Web consoles** on the home page. Remove the file to unpublish.

## Claude Manager (a singleton Claude that watches all agents)
Open it from the home page. It shows each agent's status and latest activity, can send an instruction
to an agent that runs inside Remote Terminal, answer an agent that is waiting, and open its console.
If you need a person's decision, finish your turn with the question plainly stated: the manager surfaces
agents that are waiting.
