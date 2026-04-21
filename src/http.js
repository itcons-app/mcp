#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createItconsMcpServer, loginToItcons } from "./index.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_SSE_PATH = "/sse";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const transports = new Map();
const dynamicClients = new Map();

const config = {
  host: process.env.HOST || DEFAULT_HOST,
  port: Number(process.env.PORT || DEFAULT_PORT),
  publicUrl: cleanPublicUrl(process.env.ITCONS_MCP_PUBLIC_URL),
  mcpPath: normalizePath(process.env.ITCONS_MCP_PATH || DEFAULT_MCP_PATH),
  ssePath: normalizePath(process.env.ITCONS_MCP_SSE_PATH || DEFAULT_SSE_PATH),
  oauthClientId: process.env.ITCONS_OAUTH_CLIENT_ID || "itcons-app-chatgpt",
  oauthClientSecret: process.env.ITCONS_OAUTH_CLIENT_SECRET || "",
  oauthClientsFile: process.env.ITCONS_OAUTH_CLIENTS_FILE || "",
  domainLookupUrl: process.env.ITCONS_DOMAIN_LOOKUP_URL || "https://auto.itcons.app/webhook/my-domain",
  authDisabled: process.env.ITCONS_HTTP_AUTH_DISABLED === "1"
};

await loadDynamicClients();

const app = createMcpExpressApp({
  host: config.host,
  allowedHosts: allowedHosts()
});

app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.json({
    name: "Itcons.app MCP Server",
    mcp: absoluteUrl(config.mcpPath),
    sse: absoluteUrl(config.ssePath),
    authorization: absoluteUrl("/oauth/authorize"),
    token: absoluteUrl("/oauth/token")
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/domain-lookup", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim();

    if (!email) {
      res.status(400).json({ error: "email is required" });
      return;
    }

    const domain = await lookupDomainForEmail(email);

    if (!domain) {
      res.status(404).json({ error: "domain_not_found" });
      return;
    }

    res.json({ domain });
  } catch (error) {
    res.status(502).json({ error: "domain_lookup_failed", message: error.message });
  }
});

app.get("/.well-known/oauth-authorization-server", oauthMetadataHandler);
app.get("/.well-known/oauth-authorization-server/:resource", oauthMetadataHandler);

app.get("/oauth/authorize", (req, res) => {
  const params = authorizeParams(req.query);
  res.type("html").send(renderLoginPage(params));
});

app.post("/oauth/authorize", async (req, res) => {
  try {
    const params = authorizeParams(req.body);
    let domain = normalizeDomain(String(req.body.domain || "").trim());
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    const form = { domain, username };

    if (!domain && username.includes("@")) {
      domain = await lookupDomainForEmail(username);
      form.domain = domain || "";
    }

    if (!domain || !username || !password) {
      res.status(400).type("html").send(renderLoginPage(params, "Introduce email, contraseña y dominio si no se detecta automáticamente.", form));
      return;
    }

    const itconsToken = await loginToItcons({ domain, username, password });
    const code = randomUUID();
    authCodes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      itcons: { domain, token: itconsToken, username }
    });

    const redirectUrl = new URL(params.redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    res.redirect(302, redirectUrl.toString());
  } catch (error) {
    res.status(401).type("html").send(renderLoginPage(authorizeParams(req.body), error.message, {
      domain: String(req.body.domain || ""),
      username: String(req.body.username || "")
    }));
  }
});

app.post("/oauth/token", (req, res) => {
  const client = oauthClient(req);

  if (!isValidOAuthClient(client.id, client.secret)) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (req.body.grant_type === "authorization_code") {
    exchangeAuthorizationCode(req, res, client.id);
    return;
  }

  if (req.body.grant_type === "refresh_token") {
    exchangeRefreshToken(req, res, client.id);
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

app.post("/oauth/register", async (req, res) => {
  try {
    const client = await registerOAuthClient(req.body || {});
    res.status(201).json(client);
  } catch (error) {
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: error.message
    });
  }
});

app.all(config.mcpPath, requireMcpAuth, handleMcpRequest);

if (config.ssePath !== config.mcpPath) {
  app.all(config.ssePath, requireMcpAuth, handleMcpRequest);
}

app.listen(config.port, config.host, () => {
  console.error(`Itcons.app MCP HTTP server listening on ${config.host}:${config.port}`);
  console.error(`MCP endpoint: ${absoluteUrl(config.mcpPath)}`);
  console.error(`SSE-compatible endpoint: ${absoluteUrl(config.ssePath)}`);
});

async function handleMcpRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (sessionId && !transport) {
    res.status(404).json({ error: "Unknown MCP session." });
    return;
  }

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const server = createItconsMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
}

function requireMcpAuth(req, res, next) {
  if (config.authDisabled) {
    req.auth = {
      token: "local-development",
      clientId: "local-development",
      scopes: ["itcons:mcp"],
      extra: {}
    };
    next();
    return;
  }

  const token = bearerToken(req);
  const session = token ? accessTokens.get(token) : undefined;

  if (!session || session.expiresAt <= Date.now()) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.auth = {
    token,
    clientId: session.clientId,
    scopes: ["itcons:mcp"],
    expiresAt: Math.floor(session.expiresAt / 1000),
    extra: {
      itconsDomain: session.itcons.domain,
      itconsToken: session.itcons.token,
      itconsTimezone: session.itcons.timezone
    }
  };
  next();
}

function exchangeAuthorizationCode(req, res, clientId) {
  const code = String(req.body.code || "");
  const entry = authCodes.get(code);

  if (!entry || entry.expiresAt <= Date.now()) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  if (entry.clientId !== clientId || entry.redirectUri !== req.body.redirect_uri) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  authCodes.delete(code);
  issueTokens(res, clientId, entry.itcons);
}

function exchangeRefreshToken(req, res, clientId) {
  const refreshToken = String(req.body.refresh_token || "");
  const entry = refreshTokens.get(refreshToken);

  if (!entry || entry.clientId !== clientId) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  refreshTokens.delete(refreshToken);
  issueTokens(res, clientId, entry.itcons);
}

function issueTokens(res, clientId, itcons) {
  const accessToken = randomUUID();
  const refreshToken = randomUUID();
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const session = { clientId, expiresAt, itcons };

  accessTokens.set(accessToken, session);
  refreshTokens.set(refreshToken, { clientId, itcons });

  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: "itcons:mcp"
  });
}

function oauthMetadataHandler(_req, res) {
  res.json({
    issuer: absoluteUrl(""),
    authorization_endpoint: absoluteUrl("/oauth/authorize"),
    token_endpoint: absoluteUrl("/oauth/token"),
    registration_endpoint: absoluteUrl("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["itcons:mcp"]
  });
}

function authorizeParams(source) {
  return {
    response_type: String(source.response_type || "code"),
    client_id: String(source.client_id || config.oauthClientId),
    redirect_uri: String(source.redirect_uri || ""),
    state: String(source.state || ""),
    scope: String(source.scope || "itcons:mcp")
  };
}

function oauthClient(req) {
  const header = req.headers.authorization || "";

  if (header.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [id, secret = ""] = decoded.split(":");
    return { id, secret };
  }

  return {
    id: String(req.body.client_id || ""),
    secret: String(req.body.client_secret || "")
  };
}

function isValidOAuthClient(clientId, clientSecret) {
  if (clientId === config.oauthClientId) {
    return !config.oauthClientSecret || clientSecret === config.oauthClientSecret;
  }

  const client = dynamicClients.get(clientId);

  if (!client) {
    return false;
  }

  return client.client_secret === clientSecret;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function registerOAuthClient(metadata) {
  const redirectUris = normalizeStringArray(metadata.redirect_uris);

  if (redirectUris.length === 0) {
    throw new Error("redirect_uris is required.");
  }

  const client = {
    client_id: `itcons-app-${randomUUID()}`,
    client_secret: randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: String(metadata.client_name || "Itcons.app ChatGPT App"),
    redirect_uris: redirectUris,
    grant_types: normalizeStringArray(metadata.grant_types, ["authorization_code", "refresh_token"]),
    response_types: normalizeStringArray(metadata.response_types, ["code"]),
    scope: String(metadata.scope || "itcons:mcp"),
    token_endpoint_auth_method: String(metadata.token_endpoint_auth_method || "client_secret_post")
  };

  dynamicClients.set(client.client_id, client);
  await saveDynamicClients();

  return client;
}

function normalizeStringArray(value, defaultValue = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  }

  return defaultValue;
}

async function loadDynamicClients() {
  if (!config.oauthClientsFile) {
    return;
  }

  try {
    const text = await readFile(config.oauthClientsFile, "utf8");
    const clients = JSON.parse(text);

    if (Array.isArray(clients)) {
      for (const client of clients) {
        if (client?.client_id && client?.client_secret) {
          dynamicClients.set(client.client_id, client);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function saveDynamicClients() {
  if (!config.oauthClientsFile) {
    return;
  }

  await mkdir(path.dirname(config.oauthClientsFile), { recursive: true });
  await writeFile(
    config.oauthClientsFile,
    `${JSON.stringify([...dynamicClients.values()], null, 2)}\n`,
    "utf8"
  );
}

async function lookupDomainForEmail(email) {
  if (!config.domainLookupUrl) {
    return "";
  }

  const response = await fetch(config.domainLookupUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email })
  });
  const text = await response.text();
  const body = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    if (response.status === 404) {
      return "";
    }

    const message = body?.message || body?.error || text || response.statusText;
    throw new Error(message);
  }

  return normalizeDomainLookup(body);
}

function normalizeDomainLookup(value) {
  if (Array.isArray(value)) {
    return normalizeDomainLookup(value[0]);
  }

  if (typeof value === "string") {
    return normalizeDomain(value);
  }

  if (value && typeof value === "object") {
    return normalizeDomain(
      value.domain ||
      value.dominio ||
      value.subdomain ||
      value.site ||
      value.sitio ||
      value.url ||
      value.host ||
      ""
    );
  }

  return "";
}

function normalizeDomain(value) {
  const text = String(value || "").trim().toLowerCase();

  if (!text) {
    return "";
  }

  try {
    const url = new URL(text);
    return normalizeDomain(url.hostname);
  } catch {
    return text
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.itcons\.app$/, "");
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function renderLoginPage(params, error, form = {}) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Iniciar sesión - Itcons.app</title>
  <style>
    :root { color-scheme: light; --itcons-orange: #f15a24; --text: #32363b; --muted: #747b84; --line: #d7dbe0; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; font-family: Arial, Helvetica, sans-serif; background: #f4f5f6; color: var(--text); display: flex; align-items: center; justify-content: center; }
    main { width: min(100% - 32px, 400px); padding: 34px 30px 24px; background: #fff; border: 1px solid #e1e3e6; box-shadow: 0 16px 36px rgba(34, 43, 54, .10); }
    .brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 28px; }
    .brand-mark { width: 48px; height: 48px; border-radius: 10px; background: var(--itcons-orange); position: relative; overflow: hidden; flex: 0 0 auto; }
    .brand-mark::before { content: ""; position: absolute; inset: 10px 9px; background: repeating-linear-gradient(165deg, transparent 0 8px, #fff 8px 10px); opacity: .92; transform: rotate(-11deg); }
    .brand-text { font-size: 40px; font-weight: 800; font-style: italic; letter-spacing: 0; color: var(--itcons-orange); line-height: .9; }
    .brand-text span { color: #26a269; font-size: 15px; font-style: normal; font-weight: 700; margin-left: 1px; }
    h1 { font-size: 26px; font-weight: 400; text-align: center; margin: 0 0 18px; }
    p { margin: 0 0 22px; color: var(--muted); line-height: 1.45; text-align: center; font-size: 14px; }
    label { display: block; color: #3a3f45; font-size: 13px; font-weight: 600; margin-top: 14px; }
    input { width: 100%; margin-top: 6px; padding: 13px 12px; border: 1px solid var(--line); border-radius: 3px; font: inherit; font-size: 15px; outline: none; background: #fff; }
    input:focus { border-color: var(--itcons-orange); box-shadow: 0 0 0 2px rgba(241, 90, 36, .16); }
    button { width: 100%; margin-top: 24px; padding: 13px 16px; border: 0; border-radius: 3px; background: var(--itcons-orange); color: white; font-weight: 700; font-size: 14px; letter-spacing: .02em; cursor: pointer; text-transform: uppercase; }
    button:disabled { opacity: .65; cursor: wait; }
    .domain-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: end; }
    .domain-row button { width: auto; min-width: 96px; margin-top: 0; padding: 13px 12px; background: #4b5563; }
    .hint { margin-top: 7px; min-height: 18px; color: var(--muted); font-size: 12px; }
    .hint.ok { color: #247a3d; }
    .hint.warn { color: #9a5b00; }
    .error { margin: 14px 0 0; padding: 10px 12px; border-radius: 3px; color: #8a1f11; background: #fff0ed; border: 1px solid #ffd3ca; font-size: 13px; }
    .links { display: flex; justify-content: space-between; gap: 12px; margin-top: 22px; font-size: 12px; }
    .links a { color: #6b7280; text-decoration: none; }
    .langs { margin-top: 26px; text-align: center; color: #a0a6ad; font-size: 11px; }
  </style>
</head>
<body>
  <main>
    <div class="brand" aria-label="Itcons.app">
      <div class="brand-mark"></div>
      <div class="brand-text">itcons<span>.app</span></div>
    </div>
    <h1>Iniciar sesión</h1>
    <p>Introduce el email de tu usuario. Si encontramos tu sitio, completaremos el dominio automáticamente.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="response_type" value="${escapeHtml(params.response_type)}">
      <input type="hidden" name="client_id" value="${escapeHtml(params.client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirect_uri)}">
      <input type="hidden" name="state" value="${escapeHtml(params.state)}">
      <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
      <label>Email
        <input id="username" name="username" type="email" autocomplete="username" value="${escapeHtml(form.username)}" required>
      </label>
      <div class="domain-row">
        <label>Dominio Itcons.app
          <input id="domain" name="domain" placeholder="miempresa" autocomplete="organization" value="${escapeHtml(form.domain)}">
        </label>
        <button id="lookup-domain" type="button">Buscar</button>
      </div>
      <div id="domain-hint" class="hint">Puedes dejarlo vacío si tu email está asociado a un sitio.</div>
      <label>Contraseña
        <input name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit">Siguiente</button>
    </form>
    <div class="links">
      <a href="https://itcons.app" target="_blank" rel="noreferrer">¿Qué es itcons.app?</a>
      <a href="https://itcons.app" target="_blank" rel="noreferrer">¿Necesitas soporte?</a>
    </div>
    <div class="langs">Disponible para: EN ES PT IT</div>
  </main>
  <script>
    const usernameInput = document.getElementById("username");
    const domainInput = document.getElementById("domain");
    const lookupButton = document.getElementById("lookup-domain");
    const hint = document.getElementById("domain-hint");

    async function lookupDomain() {
      const email = usernameInput.value.trim();
      if (!email || !email.includes("@")) {
        hint.textContent = "Introduce un email válido para buscar tu sitio.";
        hint.className = "hint warn";
        return;
      }

      lookupButton.disabled = true;
      hint.textContent = "Buscando sitio asociado...";
      hint.className = "hint";

      try {
        const response = await fetch("/domain-lookup?email=" + encodeURIComponent(email));
        const payload = await response.json();

        if (!response.ok || !payload.domain) {
          hint.textContent = "No hemos encontrado el sitio. Puedes escribirlo manualmente.";
          hint.className = "hint warn";
          return;
        }

        domainInput.value = payload.domain;
        hint.textContent = "Dominio detectado: " + payload.domain;
        hint.className = "hint ok";
      } catch {
        hint.textContent = "No se pudo buscar el sitio. Puedes escribirlo manualmente.";
        hint.className = "hint warn";
      } finally {
        lookupButton.disabled = false;
      }
    }

    lookupButton.addEventListener("click", lookupDomain);
    usernameInput.addEventListener("blur", () => {
      if (!domainInput.value.trim()) {
        lookupDomain();
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function absoluteUrl(pathname) {
  const base = config.publicUrl || `http://${config.host}:${config.port}`;
  const url = new URL(pathname || "/", `${base}/`);
  return url.toString().replace(/\/$/, pathname ? "" : "/");
}

function cleanPublicUrl(value) {
  return value ? String(value).replace(/\/+$/, "") : "";
}

function normalizePath(value) {
  const path = String(value || "").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function allowedHosts() {
  if (!process.env.ITCONS_MCP_ALLOWED_HOSTS) {
    return undefined;
  }

  return process.env.ITCONS_MCP_ALLOWED_HOSTS.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}
