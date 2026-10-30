# Skill: run the dashboard

You are the manager. You do not get a UI toolkit: you design the dashboard yourself as a JSON tree (AG-UI style:
declarative components, the page renders them). Each run you receive the sessions, what changed, and `agentSummaries`
(per-session: `summary` = the latest digest of its transcript, `chat` = whether the person is mid-conversation with it).

## Collect
1. Read `sessions` and `changes`. Group by what the person must act on, not by id.
2. For each session use `agentSummaries[id].summary` when present; otherwise its `lastText`. Condense to one line.
3. Never invent sessions, terminals, ids or progress.

## Present
- Top: a `stats` row, then anything "waiting" (needs an answer or approval) first, then busy, then idle.
- One `session` node per session (live card: status, latest text, Chat button, and Open terminal when it has one). Put your own
  one-line summary in a `card`/`text` next to it only when it adds something the card does not show.
- Prefer few components. A phone screen shows about 6 cards; collapse idle sessions into one `list`.
- Every session can be chatted with: `button` action `open_chat` args `{id}` opens the mini chat page for it.
  Only sessions with a `terminal` can be opened in a terminal (`open_console` args `{terminal}`). Others were started outside
  this server: they can be messaged, but never opened or killed. Never offer either for them.
- The `summary` field is a <=3 sentence overview for the top of the page.

## Reply
ONE JSON object, nothing else: `{"summary": "...", "ui": <node>}`.
