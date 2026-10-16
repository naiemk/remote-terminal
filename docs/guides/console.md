---
description: The home page, the terminal, typing on a phone, copy and paste.
---

# Using the console

## Home

<img src="../images/console-home.png" alt="Home page" width="320" align="right">

**Running** lists the terminals that are open on the computer, with their folder, age and number of viewers.

* Tap one to join it.
* Tap **×**, then **Kill?** to close it. The program gets `SIGHUP`, then `SIGKILL` after 3 seconds.

**Start** opens a new terminal with one of the [commands](commands.md).

* **in** sets the folder it starts in, for example `~/code/my-app`. Leave it empty to use the command's own `cwd`, or your home folder.
* You can run any number of terminals, including several of the same command.

Terminals belong to the server, not to the browser. Close the tab, lock the phone or lose signal, and the program keeps running. Join it again from Home.

## The terminal

<img src="../images/console-terminal.png" alt="A terminal on a phone" width="320">

* **Swipe** to scroll. In full-screen apps such as Claude Code, the swipe scrolls inside the app.
* The **key bar** along the bottom has the keys a phone keyboard lacks: `esc`, `tab`, `⇧tab`, `^C`, the arrows, `⏎`, `^D`, `^L`, `pgup` and `pgdn`. Swipe it sideways for more.
* Tapping the terminal doesn't open the phone keyboard. Tap **⌨** at the end of the key bar to type straight into the terminal.

## Compose: type or dictate

<img src="../images/console-compose.png" alt="Compose sheet" width="320">

The pencil button opens the compose box. It's the comfortable way to write a prompt for Claude Code or a long command:

* The phone's own keyboard, autocorrect and dictation all work here. Tap the 🎙 button to dictate where the browser supports it.
* **Send** types the text into the terminal. With **Press enter** on, it presses Enter afterwards.
* Text with several lines is sent as one paste, so Claude Code takes it as a single prompt.
* On a computer: **Ctrl/Cmd+K** opens it, **Enter** sends, **Shift+Enter** adds a new line.

## The menu

<img src="../images/console-menu.png" alt="Status menu" width="320">

Tap the status pill in the top-right corner (it shows the command's name):

| | |
| --- | --- |
| **Font size** | Bigger or smaller text. Saved per browser. |
| **Home** | Back to the home page. The terminal keeps running. |
| **Show key bar** | Hide the key bar for more room. |
| **Fullscreen** | Hide the browser's toolbars. |
| **Copy text…** | Open the terminal's text for selecting and copying. |
| **Paste** | Send the clipboard to the terminal. |
| **Redraw screen** | Ask the program to repaint if the screen looks wrong. |

## Copy and paste

**On a phone**

* **copy** in the key bar opens the terminal's text in a plain view. Long-press to select and use the system's Copy, or tap **Copy all**. It holds the whole scrollback for a shell, and the current screen for full-screen apps.
* **paste** in the key bar sends the clipboard to the terminal. If the browser won't share the clipboard, the compose box opens so you can paste there.

**On a computer**

* Drag to select, then **Ctrl+Shift+C** (or **Cmd+C**) to copy. Paste with **Ctrl+Shift+V** (or **Cmd+V**).
* When a program captures the mouse, as Claude Code does, hold **Shift** (or **Option** on a Mac) while dragging.

## Several viewers

Open the same terminal on your phone and your laptop at once, and both show the same screen. The terminal's size follows whichever one typed or resized last.

## Extras

* Add `?webgl` to the address to use the GPU renderer, which can be faster for busy full-screen apps.
