#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "http.js");
const port = process.env.ITCONS_HTTP_SMOKE_PORT || "3333";
const serverUrl = `http://127.0.0.1:${port}/mcp`;
const readOnlyTools = new Set([
  "itcons_check_connection",
  "itcons_list_users",
  "itcons_get_user",
  "itcons_list_clients",
  "itcons_get_client",
  "itcons_list_projects",
  "itcons_get_project",
  "itcons_list_categories",
  "itcons_get_category",
  "itcons_list_resources",
  "itcons_get_resource",
  "itcons_list_calendars",
  "itcons_get_calendar",
  "itcons_list_holidays",
  "itcons_get_working_days",
  "itcons_list_leave_types",
  "itcons_list_work_report_templates",
  "itcons_get_work_report_template",
  "itcons_list_work_reports",
  "itcons_get_work_report",
  "itcons_get_work_report_as_post_payload",
  "itcons_list_work_reports_by_date",
  "itcons_list_today_work_reports",
  "itcons_list_work_order_types",
  "itcons_get_work_order_type",
  "itcons_list_work_orders",
  "itcons_get_work_order",
  "itcons_list_statuses"
]);
const writeTools = new Set([
  "itcons_create_user",
  "itcons_update_user",
  "itcons_create_client",
  "itcons_update_client",
  "itcons_create_project",
  "itcons_update_project",
  "itcons_create_category",
  "itcons_update_category",
  "itcons_create_resource",
  "itcons_update_resource",
  "itcons_create_work_report",
  "itcons_update_work_report_metadata",
  "itcons_replace_work_report_content",
  "itcons_create_work_order",
  "itcons_update_work_order"
]);
const expectedToolCount = readOnlyTools.size + writeTools.size;

const child = spawn(process.execPath, [serverPath], {
  cwd: rootDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: port,
    ITCONS_MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    ITCONS_HTTP_AUTH_DISABLED: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForHealth(`http://127.0.0.1:${port}/health`);
  await verifyOAuthDiscovery(`http://127.0.0.1:${port}`);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client = new Client(
    {
      name: "itcons-app-mcp-http-smoke",
      version: "0.5.0"
    },
    {
      capabilities: {}
    }
  );

  await client.connect(transport);
  const { tools } = await client.listTools();
  const missingAnnotations = tools
    .filter((tool) => {
      return tool.annotations?.readOnlyHint === undefined ||
        tool.annotations?.openWorldHint === undefined ||
        tool.annotations?.destructiveHint === undefined;
    })
    .map((tool) => tool.name);
  const missingOAuthSecurity = tools
    .filter((tool) => {
      const schemes = tool.securitySchemes || tool._meta?.securitySchemes;
      return !schemes?.some((scheme) => {
        return scheme.type === "oauth2" && scheme.scopes?.includes("itcons:mcp");
      });
    })
    .map((tool) => tool.name);
  const invalidAnnotations = tools
    .filter((tool) => {
      if (readOnlyTools.has(tool.name)) {
        return tool.annotations?.readOnlyHint !== true ||
          tool.annotations?.destructiveHint !== false ||
          tool.annotations?.openWorldHint !== false;
      }

      if (writeTools.has(tool.name)) {
        return tool.annotations?.readOnlyHint !== false ||
          tool.annotations?.destructiveHint !== false ||
          tool.annotations?.openWorldHint !== false;
      }

      return false;
    })
    .map((tool) => tool.name);

  if (tools.length !== expectedToolCount) {
    throw new Error(`Expected ${expectedToolCount} tools, discovered ${tools.length}.`);
  }

  if (missingAnnotations.length > 0) {
    throw new Error(`Missing tool annotations: ${missingAnnotations.join(", ")}`);
  }

  if (missingOAuthSecurity.length > 0) {
    throw new Error(`Missing OAuth security metadata: ${missingOAuthSecurity.join(", ")}`);
  }

  if (invalidAnnotations.length > 0) {
    throw new Error(`Unexpected tool annotations: ${invalidAnnotations.join(", ")}`);
  }

  if (process.env.ITCONS_SMOKE_LIVE === "1") {
    const result = await client.callTool({
      name: "itcons_check_connection",
      arguments: {}
    });

    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "Live HTTP check failed.");
    }
  }

  await client.close();
  console.log(`OK: HTTP MCP discovered ${tools.length} tools at ${serverUrl}.`);

  if (process.env.ITCONS_SMOKE_LIVE === "1") {
    console.log("OK: live HTTP Itcons.app connection check passed.");
  }
} finally {
  child.kill();
}

async function waitForHealth(url) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 5000) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the server is ready or the timeout expires.
    }

    await sleep(100);
  }

  throw new Error("Timed out waiting for HTTP server health check.");
}

async function verifyOAuthDiscovery(origin) {
  const [resourceResponse, mainResourceResponse, reportsResourceResponse, authorizationResponse] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-protected-resource`),
    fetch(`${origin}/.well-known/oauth-protected-resource/mcp`),
    fetch(`${origin}/.well-known/oauth-protected-resource/reports-mcp`),
    fetch(`${origin}/.well-known/oauth-authorization-server`)
  ]);
  const resource = await resourceResponse.json();
  const mainResource = await mainResourceResponse.json();
  const reportsResource = await reportsResourceResponse.json();
  const authorization = await authorizationResponse.json();

  if (!resourceResponse.ok || resource.resource !== `${origin}/reports-mcp`) {
    throw new Error("Generic OAuth metadata does not advertise the public ChatGPT resource.");
  }

  if (!mainResourceResponse.ok || mainResource.resource !== `${origin}/mcp`) {
    throw new Error("Invalid main MCP protected resource metadata.");
  }

  if (!reportsResourceResponse.ok || reportsResource.resource !== `${origin}/reports-mcp`) {
    throw new Error("Invalid reports MCP protected resource metadata.");
  }

  if (!resource.authorization_servers?.includes(`${origin}/`)) {
    throw new Error("Protected resource metadata does not reference the OAuth issuer.");
  }

  if (!authorizationResponse.ok || !authorization.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("OAuth metadata does not advertise PKCE S256.");
  }

  if (!authorization.token_endpoint_auth_methods_supported?.includes("none")) {
    throw new Error("OAuth metadata does not support public PKCE clients.");
  }
}
