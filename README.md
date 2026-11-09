# Itcons.app MCP Server

Model Context Protocol server for connecting AI assistants to Itcons.app API v3.

[Itcons.app](https://itcons.app) is a business operations platform for managing work reports, work orders, projects, clients, users, calendars, categories, and operational resources.

This package can run in two modes:

- Local `stdio` mode for clients such as Codex, Claude Desktop, and other local MCP hosts.
- Remote HTTP mode for hosted MCP clients or other clients that require a public HTTPS MCP endpoint.

The MCP uses the existing Itcons.app username/password login flow (`POST /api/login_check`) and then calls API v3 with Bearer authentication.

## Features

- Resolve the tenant from `ITCONS_DOMAIN`.
- Call API v3 under `https://{ITCONS_DOMAIN}.itcons.app/api/v3`.
- List and get users, clients, projects, categories, resources, calendars, leave types, work report templates, work reports, work order types, and work orders.
- Create and patch API v3 users, clients, projects, categories, resources, work reports, and work orders.
- Keep the existing reports-only HTTP profile at `/reports-mcp` for the current ChatGPT connector.

Webhooks are intentionally not exposed as MCP tools. API v3 documents webhook payloads as outbound deliveries configured inside Itcons.app.

## Installation

From npm:

```bash
npm install -g @itcons-app/mcp
```

From this repository:

```bash
npm install
npm run check
```

## Configuration

The local `stdio` server reads Itcons.app credentials from environment variables.

```bash
ITCONS_DOMAIN=demo
ITCONS_USERNAME=user@example.com
ITCONS_PASSWORD=change-me
ITCONS_TIMEZONE=Europe/Madrid
```

For `https://demo.itcons.app`, set:

```bash
ITCONS_DOMAIN=demo
```

You may use an existing Bearer token instead of username/password:

```bash
ITCONS_DOMAIN=demo
ITCONS_TOKEN=ey...
```

`ITCONS_API_BASE_URL` is optional. If omitted, the server uses:

```text
https://ITCONS_DOMAIN.itcons.app/api/v3
```

If `ITCONS_API_BASE_URL` ends in `/api`, the server appends `/v3` automatically.

## MCP Client Example

```json
{
  "mcpServers": {
    "itcons-app": {
      "command": "itcons-app-mcp",
      "env": {
        "ITCONS_DOMAIN": "demo",
        "ITCONS_USERNAME": "user@example.com",
        "ITCONS_PASSWORD": "change-me",
        "ITCONS_TIMEZONE": "Europe/Madrid"
      }
    }
  }
}
```

## Remote HTTP Server

Start the remote MCP server:

```bash
PORT=3000 \
HOST=127.0.0.1 \
ITCONS_MCP_PUBLIC_URL=https://mcp.example.com \
ITCONS_OAUTH_CLIENT_ID=itcons-app-chatgpt \
ITCONS_OAUTH_CLIENT_SECRET=change-me \
npm run start:http
```

The remote server exposes:

- MCP Streamable HTTP endpoint: `https://mcp.example.com/mcp`
- Reports-only MCP endpoint: `https://mcp.example.com/reports-mcp`
- SSE-compatible endpoint: `https://mcp.example.com/sse`
- OAuth authorize URL: `https://mcp.example.com/oauth/authorize`
- OAuth token URL: `https://mcp.example.com/oauth/token`
- OAuth dynamic client registration URL: `https://mcp.example.com/oauth/register`
- Health check: `https://mcp.example.com/health`

When a user connects through OAuth, the login page asks for the Itcons.app email/password and domain. If `ITCONS_DOMAIN_LOOKUP_URL` is configured, the page can detect the domain from the email.

## Tools

Read-only tools:

- `itcons_check_connection`
- `itcons_list_users`
- `itcons_get_user`
- `itcons_list_clients`
- `itcons_get_client`
- `itcons_list_projects`
- `itcons_get_project`
- `itcons_list_categories`
- `itcons_get_category`
- `itcons_list_resources`
- `itcons_get_resource`
- `itcons_list_calendars`
- `itcons_get_calendar`
- `itcons_list_leave_types`
- `itcons_list_work_report_templates`
- `itcons_get_work_report_template`
- `itcons_list_work_reports`
- `itcons_get_work_report`
- `itcons_get_work_report_as_post_payload`
- `itcons_list_work_reports_by_date`
- `itcons_list_today_work_reports`
- `itcons_list_work_order_types`
- `itcons_get_work_order_type`
- `itcons_list_work_orders`
- `itcons_get_work_order`
- `itcons_list_statuses`

Write tools:

- `itcons_create_user`
- `itcons_update_user`
- `itcons_create_client`
- `itcons_update_client`
- `itcons_create_project`
- `itcons_update_project`
- `itcons_create_category`
- `itcons_update_category`
- `itcons_create_resource`
- `itcons_update_resource`
- `itcons_create_work_report`
- `itcons_update_work_report_metadata`
- `itcons_replace_work_report_content`
- `itcons_create_work_order`
- `itcons_update_work_order`

Reports-only profile tools exposed by `/reports-mcp`:

- `itcons_check_connection`
- `itcons_list_calendars`
- `itcons_list_holidays`
- `itcons_get_working_days`
- `itcons_list_leave_types`
- `itcons_list_projects`
- `itcons_list_work_orders`
- `itcons_list_work_report_models`
- `itcons_search_work_reports`
- `itcons_list_work_reports_by_date`
- `itcons_list_today_work_reports`

The reports-only profile keeps its previous work-report tool names for compatibility and adds bounded read-only operational queries. Project and work-order results are reduced to operational fields and exclude notes, user identities, locations, attachments, client details and other unnecessary private data. Public-profile list calls are capped at 50 items, and calendar calculations accept at most 366 inclusive days.

Patch tools accept a `payload` object with the exact API v3 fields documented by the Postman collection. This keeps the MCP aligned with the API without hiding partial update features such as `add` and `remove` operations.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `ITCONS_DOMAIN` | Yes | Installation subdomain. For `https://demo.itcons.app`, use `demo`. |
| `ITCONS_USERNAME` | Yes, unless `ITCONS_TOKEN` is set | Itcons.app username or email. |
| `ITCONS_PASSWORD` | Yes, unless `ITCONS_TOKEN` is set | Itcons.app password. |
| `ITCONS_TOKEN` | No | Existing Bearer token. If set, login is skipped. |
| `ITCONS_API_BASE_URL` | No | Alternative API v3 base URL. |
| `ITCONS_TIMEZONE` | No | Time zone used by `itcons_list_today_work_reports`. Defaults to `Europe/Madrid`. |
| `PORT` | No | HTTP server port. Defaults to `3000`. |
| `HOST` | No | HTTP server bind host. Defaults to `127.0.0.1`. |
| `ITCONS_MCP_PUBLIC_URL` | Yes for remote mode | Public HTTPS origin, for example `https://mcp.example.com`. |
| `ITCONS_MCP_PATH` | No | Remote MCP endpoint path. Defaults to `/mcp`. |
| `ITCONS_REPORTS_MCP_PATH` | No | Reports-only MCP endpoint path. Defaults to `/reports-mcp`. |
| `ITCONS_MCP_SSE_PATH` | No | SSE-compatible endpoint path. Defaults to `/sse`. |
| `ITCONS_MCP_ALLOWED_HOSTS` | Recommended for remote mode | Comma-separated allowed Host headers, for example `mcp.example.com`. |
| `ITCONS_OAUTH_CLIENT_ID` | No | OAuth client ID expected by the remote server. Defaults to `itcons-app-chatgpt`. |
| `ITCONS_OAUTH_CLIENT_SECRET` | Recommended for remote mode | OAuth client secret expected by the remote server. |
| `ITCONS_OAUTH_CLIENTS_FILE` | Recommended for public apps | JSON file used to persist dynamically registered OAuth clients. |
| `ITCONS_OAUTH_STATE_FILE` | Required for restart-safe OAuth | Encrypted state file for access and refresh token sessions. |
| `ITCONS_OAUTH_STATE_SECRET` | Required with the state file | Long random secret used to encrypt OAuth state at rest. |
| `ITCONS_DOMAIN_LOOKUP_URL` | No | Endpoint used to detect the Itcons.app domain from an email. Defaults to `https://auto.itcons.app/webhook/my-domain`. |
| `ITCONS_HTTP_AUTH_DISABLED` | No | Set to `1` only for local HTTP smoke tests. Disables remote MCP bearer auth. |

## Development

Run syntax checks:

```bash
npm run check
```

Run a local MCP discovery smoke test:

```bash
npm run smoke
```

Run a local HTTP MCP smoke test:

```bash
npm run smoke:http
```

Run a live read-only smoke test against Itcons.app:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:live
```

Run a live read-only HTTP smoke test against Itcons.app:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:http:live
```

Run a live OAuth smoke test that simulates a hosted-client connection:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:oauth:live
```

## Security

Do not commit `.env` files or real credentials. The package excludes `.env`, `node_modules`, and debug logs from npm publication.

Write tools perform real changes in Itcons.app. Use them only with credentials and installations where the MCP client is allowed to make changes.

For remote deployments, configure `ITCONS_OAUTH_STATE_FILE` and `ITCONS_OAUTH_STATE_SECRET`. Access and refresh token state is then encrypted at rest and survives process restarts. Authorization codes remain short-lived and in memory.

The file-backed OAuth state is designed for a single Node.js process. Use a shared transactional store before running multiple replicas.
