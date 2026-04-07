# surfagent-x

X adapter for [SurfAgent](https://surfagent.app) — production-grade X/Twitter navigation, timeline extraction, posting, replies, likes, and recovery via MCP.

## What it does

The base `surfagent-mcp` gives an AI agent generic browser hands.

`surfagent-x` gives it **X-native verbs** so it does not have to rediscover X's unstable DOM every run.

Instead of:
- inspect page
- guess selector
- click
- hope composer state is real
- get lied to by button state

You get:
- `x_get_state`
- `x_open_home`
- `x_open_profile`
- `x_open_post`
- `x_get_timeline`
- `x_search_posts`
- `x_create_post`
- `x_reply_to_post`
- `x_like_post`
- `x_recover`

## Why this exists

X is not a generic website. It has:
- route-specific UI states
- React-sensitive composer behavior
- flaky button-state signals
- community-specific posting behavior
- delayed state settlement after navigation and actions

So this adapter wraps X-specific navigation, action, verification, and recovery logic into a dedicated MCP.

## Tools

### Health & Setup
- `x_health_check`
- `x_open`

### Navigation & State
- `x_get_state`
- `x_open_home`
- `x_open_profile`
- `x_open_notifications`
- `x_open_search`
- `x_open_post`

### Timeline & Search
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
- `x_verify_text_visible`
- `x_recover`

### Autonomous research
- `x_research_topic`
- `x_map_community`

Both autonomous tools can optionally persist full JSON bundles to disk with `save: true` and an optional `outputDir`. Default save path:
- `~/.surfagent/receipts/x-research`

Saved runs now produce a folder with:
- `bundle.json`
- `summary.json`
- `receipts.json`
- one JSON file per output dataset (`posts-search.json`, `posts.json`, `threads.json`, etc.)
- `SUMMARY.md`

Autonomous receipts now include:
- failure classification per failed step
- retry/recovery event history
- run summary counts by failure class

## Setup

### Claude Code

```bash
claude mcp add surfagent-x -- npx -y surfagent-x
```

### Claude Desktop / Cursor / Windsurf

```json
{
  "mcpServers": {
    "surfagent-x": {
      "command": "npx",
      "args": ["-y", "surfagent-x"]
    }
  }
}
```

## Use alongside base SurfAgent MCP

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SURFAGENT_DAEMON_URL` | `http://127.0.0.1:7201` | SurfAgent daemon URL |
| `SURFAGENT_AUTH_TOKEN` | auto-detected | Optional auth token override |

## Product position

- **skills** teach the agent strategy
- **adapters** provide reliable site-native tools

`surfagent-x` is the first serious site adapter in that model.

## Status

Early but hardened adapter scaffold. Core state, navigation, timeline extraction, profile discovery, profile timelines, post, reply, like, community research, structured extraction, community metadata extraction, autonomous topic/community research flows, and recovery flows are implemented. Community-specific posting still needs a deeper X-specific fix path.

## License

MIT
