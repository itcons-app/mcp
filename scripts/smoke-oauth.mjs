#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "http.js");
const port = process.env.ITCONS_HTTP_SMOKE_PORT || "3336";
const origin = `http://127.0.0.1:${port}`;
const redirectUri = "http://127.0.0.1/callback";
const resource = `${origin}/mcp`;
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

assertEnv("ITCONS_DOMAIN");
assertEnv("ITCONS_USERNAME");
assertEnv("ITCONS_PASSWORD");

const child = spawn(process.execPath, [serverPath], {
  cwd: rootDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: port,
    ITCONS_MCP_PUBLIC_URL: origin
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForHealth(`${origin}/health`);
  await verifyOAuthDiscovery();
  const oauthClient = await registerClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = await authorize(oauthClient, challenge);
  const token = await exchangeCode(code, oauthClient, verifier);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  });
  const client = new Client(
    {
      name: "itcons-app-mcp-oauth-smoke",
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
  const result = await client.callTool({
    name: "itcons_check_connection",
    arguments: {}
  });

  if (tools.length !== expectedToolCount) {
    throw new Error(`Expected ${expectedToolCount} tools, discovered ${tools.length}.`);
  }

  if (missingAnnotations.length > 0) {
    throw new Error(`Missing tool annotations: ${missingAnnotations.join(", ")}`);
  }

  if (invalidAnnotations.length > 0) {
    throw new Error(`Unexpected tool annotations: ${invalidAnnotations.join(", ")}`);
  }

  if (result.isError) {
    throw new Error(result.content?.[0]?.text || "OAuth live check failed.");
  }

  await client.close();
  console.log("OK: OAuth flow and live HTTP Itcons.app check passed.");
} finally {
  child.kill();
}

async function authorize(oauthClient, challenge) {
  const body = new URLSearchParams({
    response_type: "code",
    client_id: oauthClient.client_id,
    redirect_uri: redirectUri,
    state: "smoke",
    scope: "itcons:mcp",
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
    domain: process.env.ITCONS_DOMAIN,
    username: process.env.ITCONS_USERNAME,
    password: process.env.ITCONS_PASSWORD
  });
  const response = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    body,
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const location = response.headers.get("location");

  if (response.status !== 302 || !location) {
    throw new Error(`OAuth authorize failed with status ${response.status}.`);
  }

  return new URL(location).searchParams.get("code");
}

async function exchangeCode(code, oauthClient, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauthClient.client_id,
    code_verifier: verifier,
    resource
  });
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    }
  });
  const payload = await response.json();

  if (!response.ok || !payload.access_token) {
    throw new Error(`OAuth token exchange failed with status ${response.status}.`);
  }

  return payload.access_token;
}

async function registerClient() {
  const response = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_name: "Itcons.app OAuth smoke",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "itcons:mcp",
      token_endpoint_auth_method: "none"
    })
  });
  const payload = await response.json();

  if (!response.ok || !payload.client_id) {
    throw new Error(`OAuth dynamic client registration failed with status ${response.status}.`);
  }

  return payload;
}

async function verifyOAuthDiscovery() {
  const [resourceResponse, mainResourceResponse, authorizationResponse, unauthorizedResponse] = await Promise.all([
    fetch(`${origin}/.well-known/oauth-protected-resource`),
    fetch(`${origin}/.well-known/oauth-protected-resource/mcp`),
    fetch(`${origin}/.well-known/oauth-authorization-server`),
    fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "oauth-smoke", version: "1.0.0" }
        }
      })
    })
  ]);
  const resourceMetadata = await resourceResponse.json();
  const mainResourceMetadata = await mainResourceResponse.json();
  const authorizationMetadata = await authorizationResponse.json();

  if (!resourceResponse.ok || resourceMetadata.resource !== `${origin}/reports-mcp`) {
    throw new Error("Generic protected resource metadata does not advertise the public ChatGPT resource.");
  }

  if (!mainResourceResponse.ok || mainResourceMetadata.resource !== resource) {
    throw new Error("Invalid main MCP protected resource metadata.");
  }

  if (!authorizationResponse.ok || !authorizationMetadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("OAuth metadata does not advertise PKCE S256.");
  }

  const challenge = unauthorizedResponse.headers.get("www-authenticate") || "";
  if (unauthorizedResponse.status !== 401 || !challenge.includes("resource_metadata=")) {
    throw new Error("Unauthenticated MCP requests do not advertise protected resource metadata.");
  }
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

function assertEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}
