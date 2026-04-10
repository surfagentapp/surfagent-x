# surfagent-x

X adapter for [SurfAgent](https://surfagent.app).

This adapter gives AI agents X-native verbs for navigation, extraction, posting, replies, likes, reposts, proof-first task execution, recovery, and deeper research workflows.

## What this adapter is for

Use `surfagent-x` when you need reliable X workflows like:
- opening key X surfaces
- checking route-specific state
- extracting timelines, profiles, communities, posts, and threads
- creating posts and replies
- liking posts
- running X-specific recovery flows
- doing broader topic or community research with receipts

## Why this exists

X is not a generic website.

It has:
- route-specific UI states
- React-sensitive composer behavior
- flaky button-state signals
- community-specific flows
- delayed state settlement after actions

So this adapter wraps X-specific navigation, action, verification, and recovery into dedicated tools.

It also now bakes in some hard-won X lessons:
- account switching uses a trust hierarchy instead of one weak extraction pass
- flaky switcher or composer states can trigger visual snapshot escalation
- composer flows auto-recover with real typing when text appears present but X still keeps submit disabled
- built-in state maps help agents reason about switcher, composer, and community surfaces faster

## Core tool groups

### Health and setup
- `x_health_check`
- `x_open`

### Navigation and state
- `x_get_state`
- `x_get_state_map`
- `x_open_home`
- `x_open_profile`
- `x_open_notifications`
- `x_open_search`
- `x_open_post`

### Timeline and search
- `x_get_timeline`
- `x_search_posts`
- `x_open_community`
- `x_search_communities`
- `x_search_profiles`
- `x_get_community_feed`
- `x_extract_community`
- `x_extract_post`
- `x_extract_profile`
- `x_get_profile_posts`
- `x_get_post_thread`

### Actions
- `x_get_composer_state`
- `x_create_post`
- `x_reply_to_post`
- `x_like_post`
- `x_repost_post`
- `x_follow_profile`
- `x_engage_post_task`
- `x_quote_post_task`
- `x_verify_text_visible`
- `x_recover`

### Autonomous research
- `x_research_topic`
- `x_map_community`

## Receipts and saved runs

Autonomous research tools can optionally save bundles to disk.

Default output path:
- `~/.surfagent/receipts/x-research`

Saved runs can include:
- `bundle.json`
- `summary.json`
- `receipts.json`
- per-dataset JSON files
- `SUMMARY.md`

## How to use it

Run this adapter alongside the base SurfAgent MCP.

```json
{
  "mcpServers": {
    "surfagent": {
      "command": "npx",
      "args": ["-y", "surfagent-mcp"]
    },
    "surfagent-x": {
      "command": "npx",
      "args": ["-y", "surfagent-x"]
    }
  }
}
```

### CLI task runner

For repeatable X actions, prefer the built-in deterministic task runner over a live improvised browser loop.

```bash
surfagent-x task engage-post --account reggiesurfagent --url https://x.com/surfagentapp/status/123 --repost
surfagent-x task quote-post --account solvingdilemma --url https://x.com/surfagentapp/status/123 --text "Real browser-native agents need proof, not vibes."
```

Each task run writes a journal plus screenshots under:
- `${SURFAGENT_RUN_DIR:-$TMPDIR/surfagent-x-runs}`

If you are new to SurfAgent, start here first:
- <https://github.com/surfagentapp/surfagent-docs/blob/main/docs/start-here.md>
- <https://github.com/surfagentapp/surfagent-docs/blob/main/docs/mcp-server.md>
- <https://github.com/surfagentapp/surfagent-docs/blob/main/docs/skills-and-adapters.md>

## When to use this vs skills vs raw MCP

- use `surfagent-mcp` for raw browser control
- use `surfagent-skills` for workflow rules and operating discipline
- use `surfagent-x` when you want reliable X-native verbs instead of rediscovering X every run

## Environment variables

- `SURFAGENT_DAEMON_URL` default: `http://127.0.0.1:7201`
- `SURFAGENT_AUTH_TOKEN` optional override, otherwise auto-detected
- `SURFAGENT_RUN_DIR` optional override for task-runner journals and screenshots

## Status

Early, but already one of the more capable SurfAgent adapters.

## Related repos

- [surfagent](https://github.com/surfagentapp/surfagent)
- [surfagent-mcp](https://github.com/surfagentapp/surfagent/tree/main/surfagent-mcp)
- [surfagent-docs](https://github.com/surfagentapp/surfagent-docs)
- [surfagent-skills](https://github.com/surfagentapp/surfagent-skills)

## License

MIT
