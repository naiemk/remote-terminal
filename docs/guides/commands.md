---
description: Choose what the home page can start, in ~/.remote-terminal-server/commands.json.
---

# Commands (commands.json)

The **Start** buttons on the home page come from `~/.remote-terminal-server/commands.json`. Open it with:

```bash
remote-terminal-server edit      # uses $VISUAL / $EDITOR
```

The first run creates it with your shell, plus the tools it finds installed: `claude`, `codex`, `cursor-agent`, `gemini`, `opencode`, `btop` and `htop`.

## Format

Each entry is a **name** (the button label) and a **command line**:

```json
{
  "bash": "bash",
  "claude": "claude",
  "claude (resume)": "claude --resume",
  "codex": "codex",
  "cursor": "cursor-agent",
  "btop": "btop"
}
```

To give a command its own folder, use an object with `cmd` and `cwd`:

```json
{
  "api": { "cmd": "npm run dev", "cwd": "~/code/api" },
  "notes": { "cmd": "nvim todo.md", "cwd": "~/notes" }
}
```

## How commands are run

* **No restart needed.** The file is read again every time the home page loads.
* **Your normal environment.** Commands run through a login shell (`$SHELL -lc '…'`), so `PATH` and the tools set up in your profile (mise, nvm, Homebrew, `~/.local/bin`…) are there, just as in a normal terminal.
* **Folder.** A terminal starts in the folder typed in the **in** box on the home page. If that's empty, it uses the entry's `cwd`, then `DEFAULT_CWD` from [the settings](../reference/configuration.md), then your home folder.
* **`REMOTE_TERM=1`** is set inside every terminal, so your scripts can tell when they run under Remote Terminal.
* **`REMOTE_TERM_SCRATCH`** is the terminal's own [scratch folder](console.md#files-pass-files-to-and-between-agents), for files you upload from the browser or want to download.
* The settings from `~/.remote-terminal-server/.env` (such as `PORT`) are **not** passed to the commands.

{% hint style="warning" %}
If the file isn't valid JSON, the server logs the error and offers only your shell until you fix it. `remote-terminal-server doctor` shows what it read.
{% endhint %}

## Somewhere else

Set `REMOTE_TERMINAL_HOME` to keep the settings in another folder:

```bash
REMOTE_TERMINAL_HOME=~/dotfiles/remote-terminal remote-terminal-server
```
