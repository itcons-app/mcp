#!/usr/bin/env node

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createItconsMcpServer, loginToItcons } from "./index.js";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_REPORTS_MCP_PATH = "/reports-mcp";
const DEFAULT_SSE_PATH = "/sse";
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const OAUTH_SCOPE = "itcons:mcp";
const PKCE_METHOD = "S256";
const STATE_FILE_VERSION = 1;
const MAX_DYNAMIC_CLIENTS = 1000;

const authCodes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const dynamicClients = new Map();

const config = {
  host: process.env.HOST || DEFAULT_HOST,
  port: Number(process.env.PORT || DEFAULT_PORT),
  publicUrl: cleanPublicUrl(process.env.ITCONS_MCP_PUBLIC_URL),
  mcpPath: normalizePath(process.env.ITCONS_MCP_PATH || DEFAULT_MCP_PATH),
  reportsMcpPath: normalizePath(process.env.ITCONS_REPORTS_MCP_PATH || DEFAULT_REPORTS_MCP_PATH),
  ssePath: normalizePath(process.env.ITCONS_MCP_SSE_PATH || DEFAULT_SSE_PATH),
  oauthClientId: process.env.ITCONS_OAUTH_CLIENT_ID || "itcons-app-chatgpt",
  oauthClientSecret: process.env.ITCONS_OAUTH_CLIENT_SECRET || "",
  oauthClientsFile: process.env.ITCONS_OAUTH_CLIENTS_FILE || "",
  oauthStateFile: process.env.ITCONS_OAUTH_STATE_FILE || "",
  oauthStateSecret: process.env.ITCONS_OAUTH_STATE_SECRET || "",
  domainLookupUrl: process.env.ITCONS_DOMAIN_LOOKUP_URL || "https://auto.itcons.app/webhook/my-domain",
  authDisabled: process.env.ITCONS_HTTP_AUTH_DISABLED === "1"
};

await loadDynamicClients();
await loadOAuthState();

const app = createMcpExpressApp({
  host: config.host,
  allowedHosts: allowedHosts()
});

app.set("trust proxy", "loopback");
app.use(securityHeaders);
app.use(requestAudit);
app.use("/oauth/register", rateLimit({ windowMs: 60 * 60 * 1000, max: 20 }));
app.use("/oauth/authorize", rateLimit({ windowMs: 5 * 60 * 1000, max: 60 }));
app.use("/oauth/token", rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use("/oauth/revoke", rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use("/domain-lookup", rateLimit({ windowMs: 60 * 1000, max: 60 }));

app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.json({
    name: "Itcons.app MCP Server",
    mcp: absoluteUrl(config.mcpPath),
    reports_mcp: absoluteUrl(config.reportsMcpPath),
    sse: absoluteUrl(config.ssePath),
    authorization: absoluteUrl("/oauth/authorize"),
    token: absoluteUrl("/oauth/token"),
    revocation: absoluteUrl("/oauth/revoke")
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
app.get("/.well-known/oauth-protected-resource", protectedResourceMetadataHandler(config.mcpPath));
app.get(`/.well-known/oauth-protected-resource${config.mcpPath}`, protectedResourceMetadataHandler(config.mcpPath));
app.get(`/.well-known/oauth-protected-resource${config.reportsMcpPath}`, protectedResourceMetadataHandler(config.reportsMcpPath));
app.get(`/.well-known/oauth-protected-resource${config.ssePath}`, protectedResourceMetadataHandler(config.ssePath));

app.get("/oauth/authorize", (req, res) => {
  try {
    const params = authorizeParams(req.query);
    res.type("html").send(renderLoginPage(params));
  } catch (error) {
    res.status(400).type("html").send(renderLoginPage(rawAuthorizeParams(req.query), error.message));
  }
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
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      resource: params.resource,
      scope: params.scope,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
      itcons: { domain, token: itconsToken, username }
    });

    const redirectUrl = new URL(params.redirect_uri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("iss", absoluteUrl(""));
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    res.redirect(302, redirectUrl.toString());
  } catch (error) {
    res.status(401).type("html").send(renderLoginPage(rawAuthorizeParams(req.body), error.message, {
      domain: String(req.body.domain || ""),
      username: String(req.body.username || "")
    }));
  }
});

app.post("/oauth/token", async (req, res) => {
  const client = authenticateOAuthClient(req);

  if (!client) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (req.body.grant_type === "authorization_code") {
    await exchangeAuthorizationCode(req, res, client.id);
    return;
  }

  if (req.body.grant_type === "refresh_token") {
    await exchangeRefreshToken(req, res, client.id);
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

app.post("/oauth/revoke", async (req, res) => {
  const client = authenticateOAuthClient(req);
  if (!client) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }
  const tokenHash = hashToken(String(req.body.token || ""));
  const accessEntry = accessTokens.get(tokenHash);
  const refreshEntry = refreshTokens.get(tokenHash);
  if (accessEntry?.clientId === client.id) accessTokens.delete(tokenHash);
  if (refreshEntry?.clientId === client.id) refreshTokens.delete(tokenHash);
  if (accessEntry?.clientId === client.id || refreshEntry?.clientId === client.id) await saveOAuthState();
  res.status(200).end();
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

const fullMcpHandler = createMcpRouteHandler({ toolProfile: "full" });
const reportsMcpHandler = createMcpRouteHandler({ toolProfile: "reports-only" });

app.all(config.mcpPath, requireMcpAuth, fullMcpHandler);
app.all(config.reportsMcpPath, requireMcpAuth, reportsMcpHandler);

if (config.ssePath !== config.mcpPath) {
  app.all(config.ssePath, requireMcpAuth, fullMcpHandler);
}

app.listen(config.port, config.host, () => {
  console.error(`Itcons.app MCP HTTP server listening on ${config.host}:${config.port}`);
  console.error(`MCP endpoint: ${absoluteUrl(config.mcpPath)}`);
  console.error(`Reports-only MCP endpoint: ${absoluteUrl(config.reportsMcpPath)}`);
  console.error(`SSE-compatible endpoint: ${absoluteUrl(config.ssePath)}`);
});

function createMcpRouteHandler({ toolProfile }) {
  const transports = new Map();

  return async function handleMcpRequest(req, res) {
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

      const server = createItconsMcpServer({ toolProfile });
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  };
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
  const tokenHash = token ? hashToken(token) : "";
  const session = tokenHash ? accessTokens.get(tokenHash) : undefined;

  if (!session || session.expiresAt <= Date.now()) {
    if (session && tokenHash) {
      accessTokens.delete(tokenHash);
      void saveOAuthState();
    }
    res.setHeader("WWW-Authenticate", oauthChallenge(req));
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const requestedResource = resourceForRequest(req);
  if (session.resource && session.resource !== requestedResource) {
    res.setHeader("WWW-Authenticate", oauthChallenge(req, "invalid_token"));
    res.status(401).json({ error: "invalid_token" });
    return;
  }

  req.auth = {
    token,
    clientId: session.clientId,
    scopes: String(session.scope || OAUTH_SCOPE).split(/\s+/).filter(Boolean),
    expiresAt: Math.floor(session.expiresAt / 1000),
    extra: {
      itconsDomain: session.itcons.domain,
      itconsToken: session.itcons.token,
      itconsTimezone: session.itcons.timezone
    }
  };
  next();
}

async function exchangeAuthorizationCode(req, res, clientId) {
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

  const resource = String(req.body.resource || "");
  if (resource !== entry.resource) {
    res.status(400).json({ error: "invalid_target" });
    return;
  }

  if (entry.codeChallenge && !verifyPkce(entry.codeChallenge, req.body.code_verifier)) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  authCodes.delete(code);
  await issueTokens(res, clientId, entry.itcons, entry.resource, entry.scope);
}

async function exchangeRefreshToken(req, res, clientId) {
  const refreshToken = String(req.body.refresh_token || "");
  const refreshTokenHash = hashToken(refreshToken);
  const entry = refreshTokens.get(refreshTokenHash);

  if (!entry || entry.clientId !== clientId || entry.expiresAt <= Date.now()) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }

  const resource = String(req.body.resource || "");
  if (resource !== entry.resource) {
    res.status(400).json({ error: "invalid_target" });
    return;
  }

  refreshTokens.delete(refreshTokenHash);
  await issueTokens(res, clientId, entry.itcons, entry.resource, entry.scope);
}

async function issueTokens(res, clientId, itcons, resource, scope = OAUTH_SCOPE) {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const session = { clientId, expiresAt, itcons, resource, scope };

  accessTokens.set(hashToken(accessToken), session);
  refreshTokens.set(hashToken(refreshToken), { clientId, itcons, resource, scope, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  await saveOAuthState();

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.json({
    access_token: accessToken,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope
  });
}

function oauthMetadataHandler(_req, res) {
  res.json({
    issuer: absoluteUrl(""),
    authorization_endpoint: absoluteUrl("/oauth/authorize"),
    token_endpoint: absoluteUrl("/oauth/token"),
    revocation_endpoint: absoluteUrl("/oauth/revoke"),
    registration_endpoint: absoluteUrl("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: [PKCE_METHOD],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE]
  });
}

function protectedResourceMetadataHandler(resourcePath) {
  return (_req, res) => {
    res.json({
      resource: absoluteUrl(resourcePath),
      authorization_servers: [absoluteUrl("")],
      scopes_supported: [OAUTH_SCOPE],
      resource_documentation: absoluteUrl("")
    });
  };
}

function authorizeParams(source) {
  const params = rawAuthorizeParams(source);
  validateAuthorizationRequest(params);
  return params;
}

function rawAuthorizeParams(source) {
  const params = {
    response_type: String(source.response_type || "code"),
    client_id: String(source.client_id || config.oauthClientId),
    redirect_uri: String(source.redirect_uri || ""),
    state: String(source.state || ""),
    scope: String(source.scope || OAUTH_SCOPE),
    code_challenge: String(source.code_challenge || ""),
    code_challenge_method: String(source.code_challenge_method || ""),
    resource: String(source.resource || "")
  };
  return params;
}

function validateAuthorizationRequest(params) {
  if (params.response_type !== "code") {
    throw new Error("response_type must be code.");
  }

  const client = oauthClientRecord(params.client_id);
  if (!client) {
    throw new Error("Unknown OAuth client.");
  }

  if (!params.redirect_uri) {
    throw new Error("redirect_uri is required.");
  }

  if (!params.resource) {
    throw new Error("resource is required.");
  }

  if (Array.isArray(client.redirect_uris) && !client.redirect_uris.includes(params.redirect_uri)) {
    throw new Error("redirect_uri is not registered for this OAuth client.");
  }

  if (!allowedOAuthResources().has(params.resource)) {
    throw new Error("Unsupported OAuth resource.");
  }

  const scopes = params.scope.split(/\s+/).filter(Boolean);
  if (scopes.length !== 1 || scopes[0] !== OAUTH_SCOPE) {
    throw new Error(`scope must be ${OAUTH_SCOPE}.`);
  }

  if (params.code_challenge_method && params.code_challenge_method !== PKCE_METHOD) {
    throw new Error(`code_challenge_method must be ${PKCE_METHOD}.`);
  }

  if (params.code_challenge_method && !params.code_challenge) {
    throw new Error("code_challenge is required when code_challenge_method is provided.");
  }

  if (params.code_challenge && params.code_challenge_method !== PKCE_METHOD) {
    throw new Error(`PKCE ${PKCE_METHOD} is required when code_challenge is provided.`);
  }

  if ((client.token_endpoint_auth_method || "client_secret_post") === "none" && !params.code_challenge) {
    throw new Error("PKCE code_challenge is required for public OAuth clients.");
  }
}

function authenticateOAuthClient(req) {
  const header = req.headers.authorization || "";

  if (header.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const [id, secret = ""] = decoded.split(":");
    return isValidOAuthClient(id, secret, "client_secret_basic") ? { id } : null;
  }

  const id = String(req.body.client_id || "");
  const secret = String(req.body.client_secret || "");
  const method = secret ? "client_secret_post" : "none";
  return isValidOAuthClient(id, secret, method) ? { id } : null;
}

function isValidOAuthClient(clientId, clientSecret, method) {
  if (clientId === config.oauthClientId) {
    if (!config.oauthClientSecret) {
      return method === "none" || (method === "client_secret_post" && !clientSecret);
    }

    return ["client_secret_post", "client_secret_basic"].includes(method) &&
      clientSecret === config.oauthClientSecret;
  }

  const client = dynamicClients.get(clientId);

  if (!client) {
    return false;
  }

  const expectedMethod = client.token_endpoint_auth_method || "client_secret_post";
  if (expectedMethod === "none") {
    return method === "none";
  }

  if (method !== expectedMethod) return false;
  if (client.client_secret_hash) return hashToken(clientSecret) === client.client_secret_hash;
  return client.client_secret === clientSecret;
}

function oauthClientRecord(clientId) {
  if (clientId === config.oauthClientId) {
    return {
      client_id: config.oauthClientId,
      token_endpoint_auth_method: config.oauthClientSecret ? "client_secret_post" : "none"
    };
  }

  return dynamicClients.get(clientId);
}

function allowedOAuthResources() {
  return new Set([
    absoluteUrl(config.mcpPath),
    absoluteUrl(config.reportsMcpPath),
    absoluteUrl(config.ssePath)
  ]);
}

function resourceForRequest(req) {
  if (req.path === config.reportsMcpPath) {
    return absoluteUrl(config.reportsMcpPath);
  }

  if (req.path === config.ssePath) {
    return absoluteUrl(config.ssePath);
  }

  return absoluteUrl(config.mcpPath);
}

function oauthChallenge(req, error) {
  const metadataPath = req.path === config.reportsMcpPath
    ? "/.well-known/oauth-protected-resource/reports-mcp"
    : req.path === config.ssePath
      ? "/.well-known/oauth-protected-resource/sse"
      : "/.well-known/oauth-protected-resource";
  const values = [
    `resource_metadata="${absoluteUrl(metadataPath)}"`,
    `scope="${OAUTH_SCOPE}"`
  ];

  if (error) {
    values.push(`error="${error}"`);
  }

  return `Bearer ${values.join(", ")}`;
}

function verifyPkce(expectedChallenge, verifierValue) {
  const verifier = String(verifierValue || "");
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return false;
  }

  const actualChallenge = createHash("sha256").update(verifier).digest("base64url");
  const expected = Buffer.from(String(expectedChallenge));
  const actual = Buffer.from(actualChallenge);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function registerOAuthClient(metadata) {
  if (dynamicClients.size >= MAX_DYNAMIC_CLIENTS) throw new Error("Dynamic client capacity reached.");
  const redirectUris = normalizeStringArray(metadata.redirect_uris);
  if (redirectUris.length === 0) throw new Error("redirect_uris is required.");
  for (const redirectUri of redirectUris) validateRedirectUri(redirectUri);

  const grantTypes = normalizeStringArray(metadata.grant_types, ["authorization_code", "refresh_token"]);
  if (grantTypes.length === 0 || grantTypes.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
    throw new Error("Unsupported grant_types.");
  }
  const responseTypes = normalizeStringArray(metadata.response_types, ["code"]);
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") throw new Error("response_types must contain only code.");
  const scope = String(metadata.scope || OAUTH_SCOPE);
  if (scope !== OAUTH_SCOPE) throw new Error("scope must be " + OAUTH_SCOPE + ".");
  const clientName = String(metadata.client_name || "Itcons.app ChatGPT App").trim();
  if (!clientName || clientName.length > 120 || /[<>\r\n]/.test(clientName)) throw new Error("Invalid client_name.");

  const tokenEndpointAuthMethod = String(metadata.token_endpoint_auth_method || "client_secret_post");
  if (!["none", "client_secret_post", "client_secret_basic"].includes(tokenEndpointAuthMethod)) {
    throw new Error("Unsupported token_endpoint_auth_method.");
  }
  const client = {
    client_id: "itcons-app-" + randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    scope,
    token_endpoint_auth_method: tokenEndpointAuthMethod
  };
  if (tokenEndpointAuthMethod !== "none") client.client_secret = randomBytes(32).toString("base64url");
  const storedClient = { ...client };
  if (client.client_secret) {
    storedClient.client_secret_hash = hashToken(client.client_secret);
    delete storedClient.client_secret;
  }
  dynamicClients.set(client.client_id, storedClient);
  await saveDynamicClients();
  return client;
}

function validateRedirectUri(value) {
  if (value.length > 2048 || /[\r\n]/.test(value)) throw new Error("Invalid redirect_uri.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid redirect_uri."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("redirect_uri must use HTTPS or an HTTP loopback address.");
  }
  if (url.username || url.password || url.hash) throw new Error("redirect_uri must not contain credentials or a fragment.");
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
      let migratedSecrets = false;
      for (const originalClient of clients) {
        if (!originalClient?.client_id || (!originalClient?.client_secret && !originalClient?.client_secret_hash && originalClient?.token_endpoint_auth_method !== "none")) continue;
        const client = { ...originalClient };
        if (client.client_secret) {
          client.client_secret_hash = hashToken(client.client_secret);
          delete client.client_secret;
          migratedSecrets = true;
        }
        dynamicClients.set(client.client_id, client);
      }
      if (migratedSecrets) await saveDynamicClients();
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
  const temporaryPath = config.oauthClientsFile + "." + process.pid + "." + randomUUID() + ".tmp";
  const contents = JSON.stringify([...dynamicClients.values()], null, 2) + "\n";
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, config.oauthClientsFile);
}

async function loadOAuthState() {
  if (!config.oauthStateFile && !config.oauthStateSecret) return;
  if (!config.oauthStateFile || !config.oauthStateSecret) {
    throw new Error("ITCONS_OAUTH_STATE_FILE and ITCONS_OAUTH_STATE_SECRET must be configured together.");
  }

  try {
    const envelope = JSON.parse(await readFile(config.oauthStateFile, "utf8"));
    if (envelope.version !== STATE_FILE_VERSION) throw new Error("Unsupported OAuth state file version.");
    const key = createHash("sha256").update(config.oauthStateSecret).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64url")), decipher.final()]);
    const state = JSON.parse(plaintext.toString("utf8"));
    const now = Date.now();
    let prunedSessions = false;
    for (const [tokenHash, session] of state.accessTokens || []) {
      if (session.expiresAt > now && oauthClientRecord(session.clientId)) accessTokens.set(tokenHash, session);
      else prunedSessions = true;
    }
    for (const [tokenHash, session] of state.refreshTokens || []) {
      if (session.expiresAt > now && oauthClientRecord(session.clientId)) refreshTokens.set(tokenHash, session);
      else prunedSessions = true;
    }
    if (prunedSessions) await saveOAuthState();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function saveOAuthState() {
  if (!config.oauthStateFile || !config.oauthStateSecret) return;
  const state = JSON.stringify({ accessTokens: [...accessTokens], refreshTokens: [...refreshTokens] });
  const key = createHash("sha256").update(config.oauthStateSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(state, "utf8"), cipher.final()]);
  const envelope = JSON.stringify({
    version: STATE_FILE_VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url")
  });
  await mkdir(path.dirname(config.oauthStateFile), { recursive: true });
  const temporaryPath = config.oauthStateFile + "." + process.pid + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, envelope + "\n", { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, config.oauthStateFile);
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("base64url");
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
      <input type="hidden" name="code_challenge" value="${escapeHtml(params.code_challenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(params.code_challenge_method)}">
      <input type="hidden" name="resource" value="${escapeHtml(params.resource)}">
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

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.path === "/oauth/authorize") {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  }
  next();
}

const rateLimitBuckets = new Map();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    if (rateLimitBuckets.size > 10000) {
      for (const [entryKey, entry] of rateLimitBuckets) if (entry.resetAt <= now) rateLimitBuckets.delete(entryKey);
    }
    const key = req.baseUrl + req.path + ":" + req.ip;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }
    next();
  };
}

function requestAudit(req, res, next) {
  const watched = req.path.startsWith("/oauth/") || req.path === "/domain-lookup" || req.path === config.reportsMcpPath;
  if (!watched) { next(); return; }
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "http_request",
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt,
      client_ip: req.ip
    }));
  });
  next();
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
