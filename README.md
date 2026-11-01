# session-keeper

A Claude Code mod that looks after long sessions:

- **Keeps the prompt cache warm.** The prompt cache lasts an hour. While you are idle in a big session, it sends a tiny ping every 58 minutes (at most 8 in a row) so your next message does not re-read the whole context at full price.
- **Hands over and clears by itself.** When a session passes a size or turn limit, it asks Claude to write a handover note, runs `/clear`, and starts the fresh session from that note. Notes go in `<project>/.claude/handovers/`. Claude's last reply before the clear comes along too: it is added word for word to the end of the note and quoted at the top of the fresh session (cut at 6,000 characters there; the note keeps it whole), so you can still see what Claude last told you.
- **Shows its state** in a row above the prompt: cache warm or cold, next ping, and how close the session is to clearing.

## Install

In a Claude Code terminal session:

```
/plugin install session-keeper --marketplace OutHypeR/claude-session-keeper
```

Answer `y` to add the marketplace, then pick the user scope. It runs from then on.

Or run it from a folder: clone this repository and add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (several folders are separated by `;` on Windows, `:` elsewhere), then restart Claude Code.

## Commands

| Command | What it does |
| --- | --- |
| `/autoclear on`, `/autoclear off`, `/autoclear` | Turns the automatic handover and clear on or off (toggle with no argument). On by default. Saved across sessions. |
| `/handover` | Says whether this session would clear now, and why (model, tokens, turns, cache age). |
| `/handover now` | Writes a handover and clears right away, whatever the limits. Works with autoclear off. |
| `/away on`, `/away off`, `/away` | Away mode: stops the keep-warm pings, for when you will be gone for hours. |

## When it clears

Limits depend on the model (bigger models hand over sooner):

| Model | Tokens | Turns |
| --- | --- | --- |
| Opus / Fable | 350k | 60 |
| Sonnet | 500k | 100 |
| Haiku | 500k | 150 |
| other | 150k | 80 |

It never clears a session under 30k tokens. The token limits are not capped by the model's context window: a session whose window is smaller than its limit hands over only on the turn limit, or is compacted by Claude Code itself when the window fills. If the cache has already gone cold (more than an hour idle), the limits drop to 60% for the turn that comes back to it, because that turn re-reads everything anyway: the handover then happens right after your reply, once the re-read is paid. It never hands over while you are away, so a session you never reopen costs nothing more once the pings stop. After a clear it waits at least 10 minutes before it can hand over again. Change any of these numbers at the top of `hooks/register.tsx`.

## Good to know

- **Pings cost a little usage.** Each one is a one-word model call on the cached context. Use `/away on` when you leave for a long time.
- **The pings assume a 1-hour prompt cache.** If your sessions use the 5-minute cache, a ping every 58 minutes never lands while the cache is still warm: it only costs usage. Turn `/away on` to stop the pings, and keep the handover part. (The interval is `PING_EVERY_MS` at the top of `hooks/register.tsx`.)
- **A clear starts a new session.** The old transcript stays in Claude Code's history (`claude --resume`). The handover note is what carries the work forward, so a clear mid-task can lose detail the note did not capture. Turn `/autoclear off` if you would rather clear by hand.
- **Handover notes may contain project details.** Add `.claude/handovers/` to your project's `.gitignore` if you do not want them committed.
- Each session keeps its own handover state, so several open sessions never pick up each other's notes.

## Licence

MIT. See `LICENSE`.
