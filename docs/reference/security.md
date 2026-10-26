---
description: Who can reach the server, and how.
---

# Security

{% hint style="warning" %}
Remote Terminal gives a shell on your computer to anyone who can reach it. There is no password. Tailscale is what keeps other people out, so read this page.
{% endhint %}

## What protects it

* **It only listens on `127.0.0.1`.** This is fixed in the code. A `BIND` setting is ignored with a warning. Nothing on your Wi-Fi, LAN or the internet can connect to the port directly.
* **`tailscale serve` is the only way in.** It serves HTTPS with a valid certificate, and only devices signed in to your tailnet can reach it. `tailscale serve status` should show `(tailnet only)`.
* **Other websites can't drive it through your browser.** API calls and WebSockets are refused unless they come from the console's own page (an `Origin` check).
* **Files stay in the scratch folder.** The file browser only reaches `~/.remote-terminal-server/scratch`. Paths that lead outside it, including through symlinks, are refused. Uploads never overwrite an existing file.
* **No DNS rebinding.** Requests are ignored unless they're addressed to `localhost`, `127.0.0.1`, `*.ts.net` or a name in `ALLOWED_HOSTS`.

## What you need to do

* **Never use `tailscale funnel`** for it. Funnel publishes the service to the public internet. `remote-terminal-server` warns you at startup if Funnel is on. Turn it off with `tailscale funnel reset`.
* **Don't share your tailnet, or this computer's user account, with anyone you wouldn't give a shell to.** Every device on the tailnet and every user on this machine can use it.
* With **shared machines** or tailnet ACLs, you can limit which devices may reach this machine's port 443 in the [access controls](https://login.tailscale.com/admin/acls).
* **Lock your phone.** An unlocked phone on your tailnet can open a terminal.

## Reporting a problem

Please open a private security advisory on [GitHub](https://github.com/naiemk/remote-terminal/security/advisories/new) rather than a public issue.
