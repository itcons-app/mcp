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
const serverUrl = "http://127.0.0.1:" + port + "/reports-mcp";
const readOnlyTools = new Set([
  "itcons_check_connection",
  "itcons_list_work_report_models",
  "itcons_search_work_reports",
  "itcons_list_work_reports_by_date",
  "itcons_list_today_work_reports"
]);
const writeTools = new Set([]);
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
      name: "itcons-app-mcp-reports-smoke",
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
