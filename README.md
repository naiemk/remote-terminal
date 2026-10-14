# Remote Term

Lets you use a terminal on this machine (for example a running `claude` session) from your phone's browser.

```
 your terminal ── rterm (PTY) ──ws──▶ server 127.0.0.1:12700 ◀── tailscale serve (HTTPS) ◀── browser (xterm.js)
```

The server listens on `127.0.0.1:12700` only and is reached exclusively through Tailscale. See [Access (Tailscale only)](#access-tailscale-only).

- `server/`: HTTP and WebSocket relay. It serves the client, swaps the password for a JWT, and relays any number of sessions, keeping 512 KB of scrollback per session for clients that connect later.
- `host/`: `rterm`. Each `rterm` is its own session. It runs a command in a PTY, mirrors it to your local terminal, and streams it to the server. Input from your keyboard and from the phone both go to the same PTY. The PTY size follows whichever side typed last.
- `public/`: the web client. It is a full-screen xterm with a compose sheet (type or dictate), a key bar (esc, tab, ⇧tab, ^C, arrows…) and a status menu.

## Run

```bash
npm install
cp .env.example .env    # set PASSWORD, JWT_SECRET, HOST_TOKEN
npm start               # server on 127.0.0.1:12700
./bin/rterm claude      # in your terminal (no args = $SHELL)
tailscale serve --bg 12700   # once; Tailscale remembers it
```

Open `https://<machine>.<tailnet>.ts.net` on your phone (it must be on your tailnet). Use "Add to Home Screen" to get a full-screen app.

## Multiple sessions

Run as many `rterm`s as you like, in different terminals or directories:

```bash
rterm claude                      # labelled by its directory, e.g. "plaee"
rterm --name api npm run dev      # or give it a name (also: RTERM_NAME=api)
```

- With one session running, the phone opens it directly. With several, it shows a picker; it reopens the last session you used if it's still running.
- Switch with the status pill → **Sessions**. Each session keeps its own scrollback, viewers and PTY size.
- A session ends when its command exits. If `rterm` just loses its connection (for example while the server restarts), it reconnects to the same session; one that doesn't come back within 10 minutes is dropped.
- Programs running inside `rterm` don't see the variables from `.env` (the password and tokens).

## Access (Tailscale only)

This gives whoever reaches it a shell on your machine, so it must only be used through Tailscale:

- The server always binds to `127.0.0.1`. This is hardcoded; a `BIND` value in `.env` is ignored with a warning. Nothing on your LAN, public Wi-Fi or the internet can connect to the port directly.
- `tailscale serve --bg 12700` is the only way in. It gives you HTTPS with a valid certificate, and only devices on your tailnet can reach it. Check with `tailscale serve status`, which should show `(tailnet only)` and `proxy http://127.0.0.1:12700`.
- Never use `tailscale funnel` for this. Funnel publishes the service to the public internet.
- Don't share this machine with other tailnet users, and keep the password. Tailscale limits who can reach the server; the password still guards against other devices on your tailnet and other users on this machine.
- `rterm` connects over localhost (`ws://127.0.0.1:$PORT`), so it doesn't go through Tailscale.

## Tips

- Compose: Ctrl/Cmd+K on desktop. Enter sends; Shift+Enter adds a new line. Multi-line text is sent as a bracketed paste, so Claude Code treats it as one prompt.
- On phones, tapping the terminal doesn't bring up the keyboard. Use the ⌨ key to type into the terminal directly.
- `?webgl` turns on the GPU renderer.
