---
description: Fixes for common problems.
---

# Troubleshooting

Start with:

```bash
remote-terminal-server doctor
```

## Installing

**"Missing build tools: make g++ python3"**
Linux needs a compiler to build the terminal module. Install them with the command the installer prints, then run it again. See [Requirements](../getting-started/install.md#requirements).

**"command not found: remote-terminal-server"**
Open a new terminal so your shell picks up the new `PATH`, or run `~/.local/bin/remote-terminal-server`.

**"Node.js at … is gone"**
The command remembers the Node.js it was installed with, because the terminal module is built for it. If you removed or upgraded that Node.js (for example with mise or nvm), install again:

```bash
curl -fsSL https://raw.githubusercontent.com/naiemk/remote-terminal/main/install.sh | bash
```

## Starting

**"Port 12700 is already in use"**
Another `remote-terminal-server` is probably running (check `pgrep -fa remote-terminal-server`). Otherwise pick another port with `--port 12701`, and point Tailscale at it with `tailscale serve --bg 12701`.

**"Access denied: serve config denied"** (Linux)
Allow your user to change Tailscale's settings once:

```bash
sudo tailscale set --operator=$USER
```

**`tailscale serve` prints a link and waits**
Serve or HTTPS isn't enabled for your tailnet yet. Open the link, approve it, and it carries on.

## Connecting

**The phone can't open the page**

* Is the server still running on the computer?
* Is Tailscale **connected** on the phone? Both devices should appear in `tailscale status`.
* Does `tailscale serve status` show `proxy http://127.0.0.1:12700` (or your port)?
* Is the address right? It's the full name, such as `https://laptop.tail1234.ts.net`. See [Find your machine's address](../getting-started/tailscale.md#find-your-machines-address).

**Certificate warning, or `http://` instead of `https://`**
Turn on **HTTPS Certificates** on the [DNS page](https://login.tailscale.com/admin/dns) of the admin console. The first visit after that can take a few seconds while Tailscale gets the certificate.

**"unexpected host"**
You opened it under a name other than `localhost`, `127.0.0.1` or `*.ts.net`. Add the name to `ALLOWED_HOSTS` in [the settings](configuration.md).

## In the terminal

**A command isn't found, but works in my normal terminal**
Commands run through a login shell (`$SHELL -lc`). Make sure the tool's `PATH` is set in your login profile (`~/.profile`, `~/.bash_profile` or `~/.zprofile`), not only in `~/.bashrc`.

**The screen looks garbled**
Use **Redraw screen** in the menu, or press `^L` on the key bar.

**The phone keyboard doesn't come up**
That's deliberate, so it doesn't cover the screen when you tap. Use **⌨** on the key bar, or the pencil button to compose.
