---
description: Files and settings in ~/.remote-terminal-server.
---

# Configuration

Everything lives in `~/.remote-terminal-server/`. To use another folder, set `REMOTE_TERMINAL_HOME`.

| Path | |
| --- | --- |
| `commands.json` | What the home page can start. See [Commands](../guides/commands.md). |
| `.env` | Settings (below). |
| `scratch/` | One folder per terminal, for [passing files](../guides/console.md#files-pass-files-to-and-between-agents). |
| `app/` | The installed program. Replaced on `update`. |
| `node/` | Only there if the installer downloaded Node.js. |

`remote-terminal-server config` prints these paths.

## Settings (`.env`)

```bash
# ~/.remote-terminal-server/.env
PORT=12700
DEFAULT_CWD=~/code
ALLOWED_HOSTS=myhost
```

| Setting | Default | |
| --- | --- | --- |
| `PORT` | `12700` | Local port. `--port` overrides it. If you change it, run `tailscale serve --bg <port>` again. |
| `DEFAULT_CWD` | `~` | The folder new terminals start in when neither the home page nor the command sets one. |
| `ALLOWED_HOSTS` | | Extra host names the server answers to, comma separated, besides `localhost`, `127.0.0.1` and `*.ts.net`. Useful with a custom domain in front of Tailscale. |

These can also be set as environment variables, which take precedence over `.env`. None of them are passed on to the programs running in the terminals.

There is no setting for the listen address. The server always binds to `127.0.0.1`. See [Security](security.md).
