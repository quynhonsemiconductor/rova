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

Every tool name carries the `rova_` prefix: the MCP portal fronts all apps, and tool names must
be unique across them (owner decision, 2026-10-26).

Read-only today (34 tools): `rova_whoami`, projects (`rova_list_projects`, `rova_get_project`,
`rova_list_project_members`, `rova_project_health`), work items (`rova_search_work_items`,
`rova_get_work_item`, `rova_get_work_item_by_key`, `rova_my_work`, `rova_list_backlog`,
`rova_work_item_activity`, `rova_list_comments`, `rova_work_item_code_changes`),
iterations (`rova_list_iterations`, `rova_iteration_options`, `rova_iteration_status`),
releases and milestones (`rova_list_releases`, `rova_get_release`, `rova_list_milestones`,
`rova_get_milestone`), reports (`rova_iteration_burndown`, `rova_velocity`,
`rova_team_capacity`, `rova_carryover_report`, `rova_release_tracking`), quality and teams
(`rova_list_test_cases`, `rova_get_test_case_by_key`, `rova_quality_defects`,
`rova_team_status`, `rova_list_teams`), portfolio (`rova_list_portfolio_items`,
`rova_get_portfolio_item`), and the caller's own data (`rova_unread_notifications`,
`rova_list_notifications`). Every tool returns exactly what the same person sees in the web
app — a tool call can never widen your access.

## Environment flag

The endpoint ships behind `MCP_ENABLED` (off by default, turned on for rova dev at the on-prem
cutover). The API refuses to boot with the flag on but no team domain / AUD tag — there is no
silently unauthenticated MCP. The Access application, its group and the team domain / AUD tag
are managed alongside the Cloudflare Access configuration.
