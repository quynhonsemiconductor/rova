# MCP — connecting Claude to rova

rova exposes a read-only MCP endpoint at `/mcp` on the API host. It is gated by Cloudflare
Access: connect with your `@qnsc.vn` account, act as yourself, and every tool call carries the
same permissions you have in the web app. The full plan lives in product-docs
(`platform/MCP-PLAN.md`).

> **Live after the on-prem cutover.** The endpoint turns on for rova dev when the on-prem
> deployment (k3s) carries `MCP_ENABLED=true` plus the Cloudflare Access team domain and AUD
> tag — part of the cutover change, set at deploy time.

## Claude Code (developers)

```sh
claude mcp add --transport http rova-dev https://rova-dev.qnsc.vn/mcp
```

Claude Code opens the browser for the Cloudflare Access sign-in on first use and refreshes the
token silently afterwards. The connection is per-user — remove it with
`claude mcp remove rova-dev` when you no longer need it.

## claude.ai (Team connector)

The Team Owner (CEO) adds rova as a custom connector in the claude.ai Team settings
(Settings → Connectors → Add custom connector → the same `/mcp` URL). Until that is done,
Claude Code is the only supported client.

## Available tools

Read-only today: projects, work items (search / by-key / backlog / activity / comments),
iterations (list / options / status), releases, milestones, burndown / velocity / team-capacity
reports, and the caller's own identity and unread count. Every tool returns exactly what the
same person sees in the web app — a tool call can never widen your access.

## Environment flag

The endpoint ships behind `MCP_ENABLED` (off by default, turned on for rova dev at the on-prem
cutover). The API refuses to boot with the flag on but no team domain / AUD tag — there is no
silently unauthenticated MCP. The Access application, its group and the team domain / AUD tag
are managed alongside the Cloudflare Access configuration.
