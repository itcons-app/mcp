#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json"
};

const PRIORITIES = ["urgente", "alta", "media", "baja"];
const ROLE_IDS = ["1", "2", "3"];
const WORKORDER_STATUS = {
  pendiente: 4,
  "en-ejecucion": 5,
  completado: 6,
  anulado: 7
};
const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
};
const CREATE_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true
};

let cachedToken = process.env.ITCONS_TOKEN || null;

export function createItconsMcpServer() {
const server = new Server(
  {
    name: "itcons-app-mcp-server",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "itcons_check_connection",
      description: "Validate the configured Itcons.app credentials by listing work order types.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({})
    },
    {
      name: "itcons_list_workorder_types",
      description: "List work order types from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_work_report_models",
      description: "List work report models from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_projects",
      description: "List projects/assignments from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_clients",
      description: "List clients from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_statuses",
      description: "List work report and work order statuses from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        type: enumProperty("Optional status type filter.", ["pack", "workorder"]),
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_users",
      description: "List users from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_list_resources",
      description: "List resources from Itcons.app.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        limit: integerProperty("Maximum items to return.", 1, 500)
      })
    },
    {
      name: "itcons_search_workorders",
      description: "Search work orders from Itcons.app with optional filters.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        status: statusProperty("Optional work order status. Use 4/pendiente, 5/en-ejecucion, 6/completado, or 7/anulado."),
        project: integerProperty("Optional project/assignment ID."),
        type: integerProperty("Optional work order type ID."),
        priority: stringProperty("Optional priority. Accepts urgente, alta, media, baja, or API labels such as priority.alta."),
        assigned_to: stringProperty("Optional assigned user filter. Matches username, name, email, or user ID."),
        name: stringProperty("Optional case-insensitive work order name search."),
        created_by: stringProperty("Optional creator username filter."),
        limit: integerProperty("Maximum matching items to return.", 1, 500, 100),
        offset: integerProperty("Pagination offset after filtering.", 0, undefined, 0),
        include_raw: booleanProperty("Include full raw work order objects.", false)
      })
    },
    {
      name: "itcons_list_pending_workorders",
      description: "List pending work orders from Itcons.app. Pending is status 4.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        project: integerProperty("Optional project/assignment ID."),
        type: integerProperty("Optional work order type ID."),
        priority: stringProperty("Optional priority. Accepts urgente, alta, media, baja, or API labels such as priority.alta."),
        assigned_to: stringProperty("Optional assigned user filter. Matches username, name, email, or user ID."),
        name: stringProperty("Optional case-insensitive work order name search."),
        created_by: stringProperty("Optional creator username filter."),
        limit: integerProperty("Maximum matching items to return.", 1, 500, 100),
        offset: integerProperty("Pagination offset after filtering.", 0, undefined, 0),
        include_raw: booleanProperty("Include full raw work order objects.", false)
      })
    },
    {
      name: "itcons_search_work_reports",
      description: "Search work reports, optionally by report ID or work report model.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        id: integerProperty("Work report ID."),
        model: integerProperty("Work report model ID."),
        limit: integerProperty("Maximum items to return.", 1, 500, 100),
        offset: integerProperty("Pagination offset.", 0, undefined, 0)
      })
    },
    {
      name: "itcons_list_work_reports_by_date",
      description: "List work reports matching a specific date. Accepts YYYY-MM-DD or DD/MM/YYYY.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema(
        {
          date: stringProperty("Report date in YYYY-MM-DD or DD/MM/YYYY format."),
          model: integerProperty("Optional work report model ID."),
          limit: integerProperty("Maximum matching items to return.", 1, 500, 100),
          offset: integerProperty("Pagination offset for the API request.", 0, undefined, 0)
        },
        ["date"]
      )
    },
    {
      name: "itcons_list_today_work_reports",
      description: "List work reports dated today. Uses ITCONS_TIMEZONE when set, otherwise Europe/Madrid.",
      annotations: READ_ONLY_TOOL,
      inputSchema: objectSchema({
        model: integerProperty("Optional work report model ID."),
        limit: integerProperty("Maximum matching items to return.", 1, 500, 100),
        offset: integerProperty("Pagination offset for the API request.", 0, undefined, 0)
      })
    },
    {
      name: "itcons_create_workorder",
      description: "Create a work order in Itcons.app.",
      annotations: CREATE_TOOL,
      inputSchema: objectSchema(
        {
          name: stringProperty("Work order name."),
          project: integerProperty("Project/assignment ID."),
          type: integerProperty("Work order type ID."),
          priority: enumProperty("Priority.", PRIORITIES),
          info: stringProperty("Optional work order description."),
          erpid: stringProperty("Optional ERP ID.")
        },
        ["name", "project", "type"]
      )
    },
    {
      name: "itcons_create_user",
      description: "Create a user in Itcons.app.",
      annotations: CREATE_TOOL,
      inputSchema: objectSchema(
        {
          username: stringProperty("Username."),
          email: stringProperty("Email address.", "email"),
          password: stringProperty("Initial password."),
          roles: enumProperty("Role ID: 1 administrator, 2 mobile user, 3 project manager.", ROLE_IDS, "2"),
          firstname: stringProperty("First name."),
          lastname: stringProperty("Last name."),
          dni: stringProperty("DNI/NIF."),
          erpid: stringProperty("Optional ERP ID."),
          workorder_active: booleanProperty("Can use work orders.", true),
          workorder_create: booleanProperty("Can create work orders.", true),
          projects_create: booleanProperty("Can create projects.", true),
          modelo_id: arrayProperty("Work report model IDs.", {
            type: "integer"
          })
        },
        ["username", "email", "password"]
      )
    },
    {
      name: "itcons_create_project",
      description: "Create a project/assignment in Itcons.app.",
      annotations: CREATE_TOOL,
      inputSchema: objectSchema(
        {
          name: stringProperty("Project name."),
          email: stringProperty("Optional project email.", "email"),
          info: stringProperty("Optional project information."),
          erpid: stringProperty("Optional ERP ID."),
          client: integerProperty("Optional client ID.")
        },
        ["name"]
      )
    },
    {
      name: "itcons_create_client",
      description: "Create a client in Itcons.app.",
      annotations: CREATE_TOOL,
      inputSchema: objectSchema(
        {
          name: stringProperty("Client name."),
          address: stringProperty("Address."),
          cif: stringProperty("CIF/NIF."),
          phone: stringProperty("Phone."),
          email: stringProperty("Email address.", "email"),
          erpid: stringProperty("Optional ERP ID.")
        },
        ["name"]
      )
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments || {};
  const context = itconsContext(extra);

  try {
    switch (request.params.name) {
      case "itcons_check_connection":
        return toolResult(await listResource("/workorderstypes", args.limit || 1, context));
      case "itcons_list_workorder_types":
        return toolResult(await listResource("/workorderstypes", args.limit, context));
      case "itcons_list_work_report_models":
        return toolResult(await listResource("/2.0/modelosparte", args.limit, context));
      case "itcons_list_projects":
        return toolResult(await listResource("/obras", args.limit, context));
      case "itcons_list_clients":
        return toolResult(await listResource("/clients", args.limit, context));
      case "itcons_list_statuses":
        return toolResult(await listStatuses(args, context));
      case "itcons_list_users":
        return toolResult(await listResource("/2.0/users", args.limit, context));
      case "itcons_list_resources":
        return toolResult(await listResource("/resources", args.limit, context));
      case "itcons_search_workorders":
        return toolResult(await searchWorkorders(args, context));
      case "itcons_list_pending_workorders":
        return toolResult(await listPendingWorkorders(args, context));
      case "itcons_search_work_reports":
        return toolResult(await searchWorkReports(args, context));
      case "itcons_list_work_reports_by_date":
        return toolResult(await listWorkReportsByDate(args, context));
      case "itcons_list_today_work_reports":
        return toolResult(await listTodayWorkReports(args, context));
      case "itcons_create_workorder":
        return toolResult(await createWorkorder(args, context));
      case "itcons_create_user":
        return toolResult(await createUser(args, context));
      case "itcons_create_project":
        return toolResult(await createProject(args, context));
      case "itcons_create_client":
        return toolResult(await createClient(args, context));
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error.message
        }
      ]
    };
  }
});

return server;
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function stringProperty(description, format) {
  return compact({
    type: "string",
    description,
    format
  });
}

function integerProperty(description, minimum, maximum, defaultValue) {
  return compact({
    type: "integer",
    description,
    minimum,
    maximum,
    default: defaultValue
  });
}

function booleanProperty(description, defaultValue) {
  return {
    type: "boolean",
    description,
    default: defaultValue
  };
}

function enumProperty(description, values, defaultValue) {
  return compact({
    type: "string",
    description,
    enum: values,
    default: defaultValue
  });
}

function statusProperty(description) {
  return {
    oneOf: [
      {
        type: "integer",
        enum: [4, 5, 6, 7]
      },
      {
        type: "string",
        enum: ["4", "5", "6", "7", "pendiente", "en-ejecucion", "completado", "anulado"]
      }
    ],
    description
  };
}

function arrayProperty(description, items) {
  return {
    type: "array",
    description,
    items
  };
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function itconsContext(extra) {
  const authExtra = extra?.authInfo?.extra || {};

  return {
    domain: authExtra.itconsDomain,
    token: authExtra.itconsToken,
    apiBaseUrl: authExtra.itconsApiBaseUrl,
    timezone: authExtra.itconsTimezone
  };
}

async function listResource(pathname, limit = 500, context = {}) {
  const response = await apiRequest(pathname, {}, context);
  const items = extractCollection(response);
  return limitCollection(items, limit);
}

async function listStatuses(args, context = {}) {
  const response = await apiRequest("/status", {}, context);
  const items = extractCollection(response);
  const statuses = Array.isArray(items) ? items : [];
  const filteredItems = args.type
    ? statuses.filter((status) => status?.type === args.type)
    : statuses;

  return limitCollection(filteredItems, args.limit);
}

async function searchWorkorders(args, context = {}) {
  const response = await apiRequest("/workorders", {}, context);
  const items = extractCollection(response);
  const workorders = Array.isArray(items) ? items : [];
  const filteredItems = filterWorkorders(workorders, args);
  const offset = normalizeOffset(args.offset);
  const paginatedItems = limitCollection(filteredItems.slice(offset), args.limit ?? 100);

  return {
    count: filteredItems.length,
    offset,
    limit: normalizeLimit(args.limit ?? 100),
    data: paginatedItems.map((item) => normalizeWorkorder(item, args.include_raw))
  };
}

async function listPendingWorkorders(args, context = {}) {
  return searchWorkorders({
    ...args,
    status: 4
  }, context);
}

async function searchWorkReports(args, context = {}) {
  const params = new URLSearchParams();
  addOptionalParam(params, "id", args.id);
  addOptionalParam(params, "model", args.model);
  addOptionalParam(params, "limit", args.limit ?? 100);
  addOptionalParam(params, "offset", args.offset ?? 0);

  return apiRequest(`/2.0/partes?${params.toString()}`, {}, context);
}

async function listWorkReportsByDate(args, context = {}) {
  assertRequired(args, ["date"]);

  const date = normalizeReportDate(args.date);
  const response = await searchWorkReports(args, context);
  const items = extractCollection(response);
  const filteredItems = Array.isArray(items)
    ? items.filter((item) => item?.date === date)
    : [];

  return {
    date,
    count: filteredItems.length,
    data: limitCollection(filteredItems, args.limit)
  };
}

async function listTodayWorkReports(args, context = {}) {
  return listWorkReportsByDate({
    ...args,
    date: todayReportDate(context)
  }, context);
}

async function createWorkorder(args, context = {}) {
  assertRequired(args, ["name", "project", "type"]);
  assertEnum(args.priority, PRIORITIES, "priority");

  return apiRequest("/workorders", {
    method: "POST",
    body: dropUndefined({
      name: args.name,
      project: args.project,
      isArchived: 0,
      info: emptyToUndefined(args.info),
      erpid: emptyToUndefined(args.erpid),
      status: 4,
      type: args.type,
      priority: emptyToUndefined(args.priority)
    })
  }, context);
}

async function createUser(args, context = {}) {
  assertRequired(args, ["username", "email", "password"]);
  assertEnum(args.roles ?? "2", ROLE_IDS, "roles");

  const response = await apiRequest("/2.0/users", {
    method: "POST",
    body: [
      {
        id: -1,
        username: args.username,
        email: args.email,
        password: args.password,
        roles: args.roles ?? "2",
        firstname: emptyToUndefined(args.firstname),
        lastname: emptyToUndefined(args.lastname),
        dni: args.dni ?? "",
        erpid: args.erpid ?? "",
        allAssignments: 0,
        enabled: "true",
        workorder_active: args.workorder_active ?? true,
        workorder_create: args.workorder_create ?? true,
        projects_create: args.projects_create ?? true,
        modelo_id: args.modelo_id ?? []
      }
    ]
  }, context);

  return Array.isArray(response) ? response[0] : response;
}

async function createProject(args, context = {}) {
  assertRequired(args, ["name"]);

  return apiRequest("/assignments", {
    method: "POST",
    body: dropUndefined({
      id: -1,
      name: args.name,
      email: emptyToUndefined(args.email),
      info: emptyToUndefined(args.info),
      erpid: emptyToUndefined(args.erpid),
      client: emptyToUndefined(args.client),
      cost_group_obligatory: "0",
      isArchived: "0"
    })
  }, context);
}

async function createClient(args, context = {}) {
  assertRequired(args, ["name"]);

  const response = await apiRequest("/clients", {
    method: "POST",
    body: [
      {
        id: -1,
        name: args.name,
        address: emptyToUndefined(args.address),
        cif: emptyToUndefined(args.cif),
        phone: emptyToUndefined(args.phone),
        email: emptyToUndefined(args.email),
        erpid: args.erpid ?? null
      }
    ]
  }, context);

  return Array.isArray(response) ? response[0] : response;
}

async function apiRequest(pathname, options = {}, context = {}) {
  const token = await getToken(context);
  const url = buildApiUrl(pathname, context);
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...JSON_HEADERS,
      Authorization: `Bearer ${token}`
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return parseResponse(response);
}

function buildApiUrl(pathname, context = {}) {
  const base = apiBaseUrl(context);
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = String(pathname).replace(/^\/+/, "");

  return `${cleanBase}/${cleanPath}`;
}

async function getToken(context = {}) {
  if (context.token) {
    return context.token;
  }

  if (cachedToken) {
    return cachedToken;
  }

  const domain = requiredEnv("ITCONS_DOMAIN");
  const username = requiredEnv("ITCONS_USERNAME");
  const password = requiredEnv("ITCONS_PASSWORD");
  const token = await loginToItcons({ domain, username, password });

  cachedToken = token;
  return cachedToken;
}

export async function loginToItcons({ domain, username, password }) {
  if (!domain || !username || !password) {
    throw new Error("domain, username, and password are required.");
  }

  const response = await fetch(`https://${domain}.itcons.app/api/login_check`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      _username: username,
      _password: password
    })
  });
  const body = await parseResponse(response);

  if (!body.token) {
    throw new Error("Itcons.app login succeeded but did not return body.token.");
  }

  return body.token;
}

async function parseResponse(response) {
  const text = await response.text();
  const body = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText;
    throw new Error(`[${response.status}] ${message}`);
  }

  return body;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function apiBaseUrl(context = {}) {
  if (context.apiBaseUrl) {
    return String(context.apiBaseUrl).replace(/\/+$/, "");
  }

  if (process.env.ITCONS_API_BASE_URL) {
    return process.env.ITCONS_API_BASE_URL.replace(/\/+$/, "");
  }

  const domain = context.domain || requiredEnv("ITCONS_DOMAIN");

  return `https://${domain}.itcons.app/api`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function extractCollection(response) {
  if (Array.isArray(response)) {
    return response;
  }

  if (Array.isArray(response?.data)) {
    return response.data;
  }

  return response;
}

function limitCollection(items, limit) {
  if (!Array.isArray(items)) {
    return items;
  }

  return items.slice(0, normalizeLimit(limit));
}

function normalizeOffset(offset) {
  const parsed = Number(offset ?? 0);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function normalizeLimit(limit) {
  const parsed = Number(limit ?? 500);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return 500;
  }

  return Math.min(Math.floor(parsed), 500);
}

function filterWorkorders(workorders, args) {
  return workorders.filter((workorder) => {
    const status = normalizeWorkorderStatus(args.status);

    if (status !== undefined && Number(workorder.status) !== status) {
      return false;
    }

    if (args.project !== undefined && Number(workorder.assignment_id ?? workorder.project) !== Number(args.project)) {
      return false;
    }

    if (args.type !== undefined && Number(workorder.type_id ?? workorder.type) !== Number(args.type)) {
      return false;
    }

    if (args.priority && normalizeComparable(workorder.priority) !== normalizeComparable(args.priority)) {
      return false;
    }

    if (args.assigned_to && !matchesAssignedUser(workorder.assigned_to, args.assigned_to)) {
      return false;
    }

    if (args.name && !containsText(workorder.name, args.name)) {
      return false;
    }

    if (args.created_by && !containsText(workorder.created_by, args.created_by)) {
      return false;
    }

    return true;
  });
}

function normalizeWorkorderStatus(status) {
  if (status === undefined || status === null || status === "") {
    return undefined;
  }

  const numericStatus = Number(status);

  if ([4, 5, 6, 7].includes(numericStatus)) {
    return numericStatus;
  }

  const namedStatus = WORKORDER_STATUS[normalizeComparable(status)];

  if (namedStatus) {
    return namedStatus;
  }

  throw new Error("status must be one of: 4, 5, 6, 7, pendiente, en-ejecucion, completado, anulado");
}

function normalizeWorkorder(workorder, includeRaw = false) {
  const normalized = {
    id: workorder.id,
    name: workorder.name,
    status: workorder.status,
    status_name: workorderStatusName(workorder.status),
    priority: workorder.priority ?? null,
    project_id: workorder.assignment_id ?? workorder.project ?? null,
    type_id: workorder.type_id ?? workorder.type ?? null,
    created_at: normalizeDateValue(workorder.created_at ?? workorder.created_on),
    start_date: normalizeDateValue(workorder.start_date),
    finish_date: normalizeDateValue(workorder.finish_date ?? workorder.end_date),
    completed_at: normalizeDateValue(workorder.completed_at),
    started_at: normalizeDateValue(workorder.started_at),
    rejected_at: normalizeDateValue(workorder.rejected_at),
    created_by: workorder.created_by ?? null,
    assigned_to: normalizeUsers(workorder.assigned_to),
    received_by: normalizeUsers(workorder.received_by),
    readed_by: normalizeUsers(workorder.readed_by)
  };

  if (includeRaw) {
    normalized.raw = workorder;
  }

  return normalized;
}

function workorderStatusName(status) {
  switch (Number(status)) {
    case 4:
      return "Pendiente";
    case 5:
      return "En ejecución";
    case 6:
      return "Completado";
    case 7:
      return "Anulado";
    default:
      return null;
  }
}

function normalizeDateValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return value?.date ?? null;
}

function normalizeUsers(users) {
  if (!Array.isArray(users)) {
    return users ?? null;
  }

  return users.map((user) => ({
    id: user.id ?? null,
    username: user.username ?? user.name ?? null,
    email: user.email ?? null
  }));
}

function matchesAssignedUser(users, query) {
  if (!Array.isArray(users)) {
    return containsText(users, query);
  }

  return users.some((user) => {
    return [user.id, user.username, user.name, user.email].some((value) => containsText(value, query));
  });
}

function containsText(value, query) {
  return normalizeComparable(value).includes(normalizeComparable(query));
}

function normalizeComparable(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeReportDate(value) {
  const text = String(value || "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    return text;
  }

  throw new Error("date must be in YYYY-MM-DD or DD/MM/YYYY format.");
}

function todayReportDate(context = {}) {
  const timezone = context.timezone || process.env.ITCONS_TIMEZONE || "Europe/Madrid";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.day}/${values.month}/${values.year}`;
}

function addOptionalParam(params, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    params.set(key, String(value));
  }
}

function assertRequired(args, fields) {
  const missing = fields.filter((field) => args[field] === undefined || args[field] === null || args[field] === "");

  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
  }
}

function assertEnum(value, values, field) {
  if (value !== undefined && value !== null && value !== "" && !values.includes(String(value))) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
}

function emptyToUndefined(value) {
  return value === "" ? undefined : value;
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

async function main() {
  const server = createItconsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  await main();
}
