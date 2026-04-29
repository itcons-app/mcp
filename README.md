# Itcons.app MCP Server

Model Context Protocol server for connecting AI assistants to Itcons.app.

[Itcons.app](https://itcons.app) is a business operations platform for managing work reports, work orders, projects, clients, users, and related operational resources. It is designed to help teams digitize field and office workflows around daily reports, assignments, task tracking, and service execution.

This package can run in two modes:

- Local `stdio` mode for clients such as Codex, Claude Desktop, and other local MCP hosts.
- Remote HTTP mode for hosted MCP clients such as ChatGPT Apps or other clients that require a public HTTPS MCP endpoint.

With this MCP server, an assistant can query Itcons.app data, search work reports and work orders, list operational catalogs such as statuses, users, resources, projects, and clients, and create supported Itcons.app records when the configured user has permission to do so.

## Features

- Authenticate with `POST /api/login_check`.
- Use Bearer authentication for Itcons.app API calls.
- Resolve the API base URL from `ITCONS_DOMAIN`.
- List statuses, users, resources, clients, projects, work order types, and work report models.
- Search work reports and work orders.
- Create clients, projects, users, and work orders.

Webhooks are intentionally not included in this MCP server. The remote HTTP mode is for MCP client traffic, not inbound Itcons.app webhook delivery.

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

If Node was installed with Homebrew and `node`/`npm` are not in your PATH, use:

```bash
/opt/homebrew/opt/node/bin/npm install
/opt/homebrew/opt/node/bin/npm run check
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
https://ITCONS_DOMAIN.itcons.app/api
```

## MCP Client Example

Example configuration using a globally installed package:

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
- SSE-compatible endpoint: `https://mcp.example.com/sse`
- OAuth authorize URL: `https://mcp.example.com/oauth/authorize`
- OAuth token URL: `https://mcp.example.com/oauth/token`
- OAuth dynamic client registration URL: `https://mcp.example.com/oauth/register`
- Health check: `https://mcp.example.com/health`

For ChatGPT's "Create app" screen, use the public MCP URL:

```text
https://mcp.example.com/mcp
```

If a client specifically asks for an SSE URL, use:

```text
https://mcp.example.com/sse
```

When the user connects the app, the OAuth login page asks for their Itcons.app email and password. If `ITCONS_DOMAIN_LOOKUP_URL` is configured, the page tries to detect the Itcons.app domain from the email; otherwise the user can type the domain manually. The server validates those credentials with Itcons.app and stores an in-memory session token for subsequent MCP calls.

Example configuration using a local checkout:

```json
{
  "mcpServers": {
    "itcons-app": {
      "command": "node",
      "args": [
        "/absolute/path/to/itcons-app-mcp/src/index.js"
      ],
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

## Tools

Read-only tools:

- `itcons_check_connection`
- `itcons_list_workorder_types`
- `itcons_list_work_report_models`
- `itcons_list_projects`
- `itcons_list_clients`
- `itcons_list_statuses`
- `itcons_list_users`
- `itcons_list_resources`
- `itcons_search_workorders`
- `itcons_list_pending_workorders`
- `itcons_search_work_reports`
- `itcons_list_work_reports_by_date`
- `itcons_list_today_work_reports`

Create tools:

- `itcons_create_workorder`
- `itcons_create_user`
- `itcons_create_project`
- `itcons_create_client`

Tool annotations:

- Read-only tools set `readOnlyHint: true`, `destructiveHint: false`, and `openWorldHint: false` because they only read private Itcons.app data.
- Create tools set `readOnlyHint: false`, `destructiveHint: false`, and `openWorldHint: false` because they create records only inside a private Itcons.app workspace and do not publish to public internet surfaces.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `ITCONS_DOMAIN` | Yes | Installation subdomain. For `https://demo.itcons.app`, use `demo`. |
| `ITCONS_USERNAME` | Yes, unless `ITCONS_TOKEN` is set | Itcons.app username or email. |
| `ITCONS_PASSWORD` | Yes, unless `ITCONS_TOKEN` is set | Itcons.app password. |
| `ITCONS_TOKEN` | No | Existing Bearer token. If set, login is skipped. |
| `ITCONS_API_BASE_URL` | No | Alternative API base URL. |
| `ITCONS_TIMEZONE` | No | Time zone used by `itcons_list_today_work_reports`. Defaults to `Europe/Madrid`. |
| `PORT` | No | HTTP server port. Defaults to `3000`. |
| `HOST` | No | HTTP server bind host. Defaults to `127.0.0.1`. |
| `ITCONS_MCP_PUBLIC_URL` | Yes for remote mode | Public HTTPS origin, for example `https://mcp.example.com`. |
| `ITCONS_MCP_PATH` | No | Remote MCP endpoint path. Defaults to `/mcp`. |
| `ITCONS_MCP_SSE_PATH` | No | SSE-compatible endpoint path. Defaults to `/sse`. |
| `ITCONS_MCP_ALLOWED_HOSTS` | Recommended for remote mode | Comma-separated allowed Host headers, for example `mcp.example.com`. |
| `ITCONS_OAUTH_CLIENT_ID` | No | OAuth client ID expected by the remote server. Defaults to `itcons-app-chatgpt`. |
| `ITCONS_OAUTH_CLIENT_SECRET` | Recommended for remote mode | OAuth client secret expected by the remote server. |
| `ITCONS_OAUTH_CLIENTS_FILE` | Recommended for public apps | JSON file used to persist dynamically registered OAuth clients. |
| `ITCONS_DOMAIN_LOOKUP_URL` | No | Endpoint used to detect the Itcons.app domain from an email. Defaults to `https://auto.itcons.app/webhook/my-domain`. |
| `ITCONS_HTTP_AUTH_DISABLED` | No | Set to `1` only for local HTTP smoke tests. Disables remote MCP bearer auth. |

## Notes

- Work order pending status is `4`.
- `itcons_search_workorders` fetches `/workorders` and applies filters locally.
- `itcons_list_work_reports_by_date` filters on the `date` field returned by `/2.0/partes`.
- `itcons_create_workorder` sends `status: 4` and `isArchived: 0`.
- `itcons_create_user` sends an array payload to `/2.0/users`, matching the current API.
- `itcons_create_client` sends an array payload to `/clients` and returns the first array item when applicable.

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

Run a live read-only HTTP smoke test against Itcons.app:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:http:live
```

Run a live OAuth smoke test that simulates a ChatGPT-style connection:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:oauth:live
```

Run a live read-only smoke test against Itcons.app:

```bash
ITCONS_DOMAIN=demo \
ITCONS_USERNAME=user@example.com \
ITCONS_PASSWORD=change-me \
npm run smoke:live
```

Publish the public npm package:

```bash
npm publish --access public
```

## Security

Do not commit `.env` files or real credentials. The package excludes `.env`, `node_modules`, and debug logs from npm publication.

Create tools perform real writes in Itcons.app. Use them only with credentials and installations where the MCP client is allowed to make changes.

The built-in remote OAuth implementation stores authorization codes and access tokens in memory. Use a single Node.js process for the first deployment, or replace the in-memory maps with persistent storage such as Redis before running multiple replicas.
