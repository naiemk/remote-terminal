---
description: Start remote-terminal-server automatically, so it's there when you reach for your phone.
---

# Keep it running

The terminals live inside `remote-terminal-server`. When it stops, they stop too. Here are some ways to keep it running.

`tailscale serve --bg` only needs to be set up once; Tailscale remembers it. Pass `--no-serve --no-qr` when running as a service, so the server never waits for an answer.

{% tabs %}
{% tab title="Linux (systemd)" %}
Create `~/.config/systemd/user/remote-terminal-server.service`:

```ini
[Unit]
Description=Remote Terminal
After=network-online.target

[Service]
ExecStart=%h/.local/bin/remote-terminal-server --no-serve --no-qr
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now remote-terminal-server
loginctl enable-linger "$USER"     # keep it running when you're logged out
journalctl --user -u remote-terminal-server -f   # logs
```

Services don't read your shell profile, but commands run through a login shell, so they still get your `PATH`.
{% endtab %}

{% tab title="macOS (launchd)" %}
Create `~/Library/LaunchAgents/com.remote-terminal-server.plist`, replacing `YOU` with your user name:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.remote-terminal-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/remote-terminal-server</string>
    <string>--no-serve</string>
    <string>--no-qr</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/remote-terminal-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/remote-terminal-server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.remote-terminal-server.plist
```

To keep the Mac awake while you work from your phone, run `caffeinate -s` or change the Energy settings.
{% endtab %}

{% tab title="tmux" %}
The quick way:

```bash
tmux new -d -s rts remote-terminal-server
```

Attach with `tmux attach -t rts`.
{% endtab %}
{% endtabs %}
