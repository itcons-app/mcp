#!/usr/bin/env node

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
  const oauthClient = await registerClient();
  const code = await authorize(oauthClient);
  const token = await exchangeCode(code, oauthClient);
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
  const result = await client.callTool({
    name: "itcons_check_connection",
    arguments: {}
  });

  if (tools.length !== 17) {
    throw new Error(`Expected 17 tools, discovered ${tools.length}.`);
  }

  if (missingAnnotations.length > 0) {
    throw new Error(`Missing tool annotations: ${missingAnnotations.join(", ")}`);
  }

  if (result.isError) {
    throw new Error(result.content?.[0]?.text || "OAuth live check failed.");
  }

  await client.close();
  console.log("OK: OAuth flow and live HTTP Itcons.app check passed.");
} finally {
  child.kill();
}

async function authorize(oauthClient) {
  const body = new URLSearchParams({
    response_type: "code",
    client_id: oauthClient.client_id,
    redirect_uri: redirectUri,
    state: "smoke",
    scope: "itcons:mcp",
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

async function exchangeCode(code, oauthClient) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauthClient.client_id,
    client_secret: oauthClient.client_secret
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
      token_endpoint_auth_method: "client_secret_post"
    })
  });
  const payload = await response.json();

  if (!response.ok || !payload.client_id || !payload.client_secret) {
    throw new Error(`OAuth dynamic client registration failed with status ${response.status}.`);
  }

  return payload;
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
