---
description: remote-terminal-server commands and options.
---

# CLI

```
remote-terminal-server [start] [options]   start the server (default)
remote-terminal-server doctor              check Tailscale and settings, then exit
remote-terminal-server edit                open commands.json in $EDITOR
remote-terminal-server config              print where the settings live
remote-terminal-server update              reinstall the latest version
```

## Options

| Option | |
| --- | --- |
| `-p`, `--port <n>` | Local port. Default `12700`, or `PORT` in `.env`. |
| `-y`, `--yes` | Run `tailscale serve` without asking when it isn't set up. |
| `--no-serve` | Never offer to run `tailscale serve`. |
| `--no-qr` | Don't print the QR code. |
| `-h`, `--help` | Show help. |
| `-v`, `--version` | Print the version. |

## What `start` does

1. Creates `~/.remote-terminal-server/` with `commands.json` and `.env` on the first run.
2. Checks Tailscale. None of these results stop the server:
   * **Not installed:** prints the [download link](https://tailscale.com/download), and only this computer can connect.
   * **Installed but not connected:** suggests `tailscale up`.
   * **Connected, not serving this port:** offers to run `tailscale serve --bg <port>`. It asks only in an interactive terminal. With `--yes` it runs it without asking, and with `--no-serve` it never does.
   * **Funnel on:** prints a warning, because the server would be on the public internet.
3. Starts the server on `127.0.0.1:<port>` and prints the tailnet address and a QR code.

Stop it with **Ctrl+C**. The terminals it started get `SIGHUP` and close with it.

## `doctor`

```
$ remote-terminal-server doctor
remote-terminal-server 1.0.0  node v22.11.0, linux-x64

✓ ~/.remote-terminal-server/commands.json: bash, claude, codex
✓ node-pty loads
✓ Tailscale: https://laptop.tail1234.ts.net → 127.0.0.1:12700
```

Run it first when something doesn't work.

## Exit codes

| | |
| --- | --- |
| `0` | Stopped normally |
| `1` | Couldn't start, for example because the port is already in use |
| `2` | Bad arguments |
