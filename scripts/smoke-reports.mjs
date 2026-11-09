#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "http.js");
const port = process.env.ITCONS_HTTP_SMOKE_PORT || "3333";
const serverUrl = "http://127.0.0.1:" + port + "/reports-mcp";
const readOnlyTools = new Set([
  "itcons_check_connection",
  "itcons_list_calendars",
  "itcons_list_holidays",
  "itcons_get_working_days",
  "itcons_list_leave_types",
  "itcons_list_projects",
  "itcons_list_work_orders",
  "itcons_list_work_report_models",
  "itcons_search_work_reports",
  "itcons_list_work_reports_by_date",
  "itcons_list_today_work_reports"
]);
const writeTools = new Set([]);
const expectedToolCount = readOnlyTools.size + writeTools.size;
const apiPort = process.env.ITCONS_API_SMOKE_PORT || String(Number(port) + 1000);
const mockApi = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${apiPort}`);
  const payload = mockApiResponse(url);
  response.writeHead(payload.status || 200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload.body));
});

await new Promise((resolve, reject) => {
  mockApi.once("error", reject);
  mockApi.listen(Number(apiPort), "127.0.0.1", resolve);
});

const child = spawn(process.execPath, [serverPath], {
  cwd: rootDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: port,
    ITCONS_MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    ITCONS_HTTP_AUTH_DISABLED: "1",
    ITCONS_API_BASE_URL: `http://127.0.0.1:${apiPort}/api/v3`,
    ITCONS_TOKEN: "smoke-test-token"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForHealth(`http://127.0.0.1:${port}/health`);
  await verifyOAuthDiscovery(`http://127.0.0.1:${port}`);

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
  const client = new Client(
    {
      name: "itcons-app-mcp-reports-smoke",
      version: "0.5.0"
    },
    {
      capabilities: {}
    }
  );

  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolNames = new Set(tools.map((tool) => tool.name));
  const missingTools = [...readOnlyTools, ...writeTools].filter((name) => !toolNames.has(name));
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

  if (missingTools.length > 0) {
    throw new Error(`Missing expected reports-only tools: ${missingTools.join(", ")}`);
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

  await verifyLowRiskQueries(client);

  if (process.env.ITCONS_SMOKE_LIVE === "1") {
    const result = await client.callTool({
      name: "itcons_check_connection",
      arguments: {}
    });

    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "Live reports-only HTTP check failed.");
    }
  }

  await client.close();
  console.log(`OK: Reports-only MCP discovered ${tools.length} tools at ${serverUrl}.`);

  if (process.env.ITCONS_SMOKE_LIVE === "1") {
    console.log("OK: live HTTP Itcons.app connection check passed.");
  }
} finally {
  child.kill();
  await new Promise((resolve) => mockApi.close(resolve));
}

async function verifyLowRiskQueries(client) {
  const holidays = await callJsonTool(client, "itcons_list_holidays", {
    calendar_id: 1,
    date_from: "2026-01-01",
    date_to: "2026-01-10"
  });
  if (holidays.holidays?.length !== 1 || holidays.holidays[0]?.name !== "New Year") {
    throw new Error("Holiday filtering returned an unexpected result.");
  }

  const workingDays = await callJsonTool(client, "itcons_get_working_days", {
    calendar_id: 1,
    date_from: "2026-01-01",
    date_to: "2026-01-04"
  });
  if (workingDays.working_days_count !== 1 || workingDays.non_working_days_count !== 3) {
    throw new Error("Working-day calculation returned unexpected counts.");
  }

  const invalidRange = await client.callTool({
    name: "itcons_get_working_days",
    arguments: { calendar_id: 1, date_from: "2026-01-01", date_to: "2027-01-02" }
  });
  if (!invalidRange.isError || !invalidRange.content?.[0]?.text?.includes("366 days")) {
    throw new Error("Working-day calculation did not reject an oversized date range.");
  }

  const projects = await callJsonTool(client, "itcons_list_projects", { limit: 500 });
  const projectText = JSON.stringify(projects);
  if (!projectText.includes("Safe project") || /project@example.com|private project note|operator@example.com/.test(projectText)) {
    throw new Error("Reports-only project results leaked excluded fields.");
  }

  const workOrders = await callJsonTool(client, "itcons_list_work_orders", { limit: 500 });
  const workOrderText = JSON.stringify(workOrders);
  if (!workOrderText.includes("Safe work order") || /private note|operator@example.com|latitude|attachment\.pdf/.test(workOrderText)) {
    throw new Error("Reports-only work order results leaked excluded fields.");
  }
}

async function callJsonTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content?.[0]?.text || `${name} failed.`);
  return JSON.parse(result.content?.[0]?.text || "null");
}

function mockApiResponse(url) {
  if (url.pathname === "/api/v3/calendars/1") {
    return {
      body: {
        data: {
          id: 1,
          name: "Default calendar",
          saturday_day_off: true,
          sunday_day_off: true,
          enabled: true,
          holidays: [
            { name: "New Year", date: "2026-01-01" },
            { name: "Outside range", date: "2026-02-01" }
          ]
        }
      }
    };
  }

  if (url.pathname === "/api/v3/projects") {
    if (url.searchParams.get("limit") !== "50") throw new Error("Project limit was not clamped to 50.");
    return {
      body: {
        data: [{
          id: 1,
          erpid: "PROJECT-1",
          name: "Safe project",
          email: "project@example.com",
          info: "private project note",
          users: [{ email: "operator@example.com" }],
          is_archived: false
        }],
        meta: { page: 1, limit: 50, total: 1, has_next_page: false }
      }
    };
  }

  if (url.pathname === "/api/v3/work-orders") {
    if (url.searchParams.get("limit") !== "50") throw new Error("Work-order limit was not clamped to 50.");
    return {
      body: {
        data: [{
          id: 2,
          erpid: "WO-2",
          identifier: 2,
          name: "Safe work order",
          note: { body: "private note" },
          assigned_users: [{ email: "operator@example.com" }],
          locations: [{ latitude: 43, longitude: -2 }],
          attachments: [{ label: "attachment.pdf" }],
          status: { id: 4, name: "Open" },
          project: { id: 1, erpid: "PROJECT-1", name: "Safe project" },
          priority: "high"
        }],
        meta: { page: 1, limit: 50, total: 1, has_next_page: false }
      }
    };
  }

  return { status: 404, body: { error: "not_found" } };
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
  const [resourceResponse, authorizationResponse] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-protected-resource`),
    fetch(`${origin}/.well-known/oauth-authorization-server`)
  ]);
  const resource = await resourceResponse.json();
  const authorization = await authorizationResponse.json();

  if (!resourceResponse.ok || resource.resource !== `${origin}/mcp`) {
    throw new Error("Invalid OAuth protected resource metadata.");
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
