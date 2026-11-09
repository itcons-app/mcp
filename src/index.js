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

const PRIORITIES = ["urgent", "high", "medium", "low", "urgente", "alta", "media", "baja"];
const USER_ROLES = ["administrator", "mobile_user", "project_manager", "admin", "manager", "user"];
const READ_ONLY_PRIVATE_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
};
const WRITE_PRIVATE_TOOL = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false
};
const OAUTH_SECURITY_SCHEMES = [
  {
    type: "oauth2",
    scopes: ["itcons:mcp"]
  }
];
const REPORTS_ONLY_TOOL_NAMES = [
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
];
const REPORTS_COMPAT_TOOL_NAMES = [
  "itcons_list_work_report_models",
  "itcons_search_work_reports"
];

const TOOL_DEFINITIONS = [
  readTool("itcons_check_connection", "Validate the configured Itcons.app credentials against API v3 without modifying data.", {}),

  readTool("itcons_list_users", "List users from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_get_user", "Get one user by API v3 ID.", idSchema("user_id")),
  writeTool("itcons_create_user", "Create a user in Itcons.app API v3.", objectSchema({
    username: stringProperty("Username."),
    email: stringProperty("Email address.", "email"),
    role: enumProperty("User role.", USER_ROLES, "mobile_user"),
    password: stringProperty("Optional initial password."),
    first_name: stringProperty("First name."),
    last_name: stringProperty("Last name."),
    legal_id: stringProperty("Legal ID, DNI or NIF."),
    erpid: stringProperty("ERP identifier."),
    leave_manager_email: stringProperty("Leave manager email.", "email"),
    calendar_id: integerProperty("Calendar ID."),
    enabled: booleanProperty("Whether the user is enabled.", true),
    all_assignments: booleanProperty("Whether the user can access all projects.", false),
    report_template_ids: arrayProperty("Work report template IDs.", { type: "integer" })
  }, ["username", "email"])),
  writeTool("itcons_update_user", "Patch a user in Itcons.app API v3.", patchSchema("user_id")),

  readTool("itcons_list_clients", "List clients from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_get_client", "Get one client by API v3 ID.", idSchema("client_id")),
  writeTool("itcons_create_client", "Create a client in Itcons.app API v3.", objectSchema({
    name: stringProperty("Client name."),
    address: stringProperty("Address."),
    tax_id: stringProperty("Tax ID/CIF/NIF."),
    phone: stringProperty("Phone."),
    email: stringProperty("Email address.", "email"),
    erpid: stringProperty("ERP identifier.")
  }, ["name"])),
  writeTool("itcons_update_client", "Patch a client in Itcons.app API v3.", patchSchema("client_id")),

  readTool("itcons_list_projects", "List projects from Itcons.app API v3.", objectSchema({
    ...paginationSchema().properties,
    search: stringProperty("Filter projects by text search."),
    erpid: stringProperty("Filter by project ERP identifier."),
    client_id: integerProperty("Filter by client ID."),
    client_erpid: stringProperty("Filter by client ERP identifier."),
    user_id: integerProperty("Filter by assigned user ID."),
    updated_since: stringProperty("Filter projects updated since this ISO 8601 date/time."),
    is_archived: booleanProperty("Filter archived projects.")
  })),
  readTool("itcons_get_project", "Get one project by API v3 ID.", idSchema("project_id")),
  writeTool("itcons_create_project", "Create a project in Itcons.app API v3.", objectSchema({
    name: stringProperty("Project name."),
    erpid: stringProperty("ERP identifier."),
    client_id: integerProperty("Client ID."),
    client_erpid: stringProperty("Client ERP identifier."),
    email: stringProperty("Project email.", "email"),
    info: stringProperty("Project notes."),
    kpi: stringProperty("KPI."),
    signer: stringProperty("Signer."),
    cost_group_required: booleanProperty("Whether cost group is required."),
    users: arrayProperty("Assigned users. Each item may contain user_id, user_email or user_erpid.", looseObjectSchema()),
    areas: arrayProperty("Project areas.", looseObjectSchema()),
    links: arrayProperty("Project links.", looseObjectSchema()),
    started_at: stringProperty("Start date in YYYY-MM-DD format."),
    finished_at: stringProperty("Finish date in YYYY-MM-DD format."),
    is_archived: booleanProperty("Whether the project is archived.", false)
  }, ["name"])),
  writeTool("itcons_update_project", "Patch a project in Itcons.app API v3.", patchSchema("project_id")),

  readTool("itcons_list_categories", "List resource/work report categories from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_get_category", "Get one category by API v3 ID.", idSchema("category_id")),
  writeTool("itcons_create_category", "Create a category in Itcons.app API v3.", objectSchema({
    name: stringProperty("Category name."),
    parent_id: nullableIntegerProperty("Parent category ID."),
    show_in_work_order: booleanProperty("Whether the category is visible in work orders."),
    resource_attribute_ids: arrayProperty("Resource attribute IDs.", { type: "integer" }),
    work_report_attributes: arrayProperty("Work report attribute mappings.", looseObjectSchema())
  }, ["name"])),
  writeTool("itcons_update_category", "Patch a category in Itcons.app API v3.", patchSchema("category_id")),

  readTool("itcons_list_resources", "List resources from Itcons.app API v3.", objectSchema({
    ...paginationSchema().properties,
    include_subcategories: booleanProperty("Include resources from subcategories.", false),
    is_archived: booleanProperty("Filter archived resources.")
  })),
  readTool("itcons_get_resource", "Get one resource by API v3 ID.", idSchema("resource_id")),
  writeTool("itcons_create_resource", "Create a resource in Itcons.app API v3.", objectSchema({
    name: stringProperty("Resource name."),
    erpid: stringProperty("ERP identifier."),
    category_id: integerProperty("Category ID."),
    is_archived: booleanProperty("Whether the resource is archived.", false),
    attributes: arrayProperty("Resource attribute values.", looseObjectSchema())
  }, ["name", "category_id"])),
  writeTool("itcons_update_resource", "Patch a resource in Itcons.app API v3.", patchSchema("resource_id")),

  readTool("itcons_list_calendars", "List calendars from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_get_calendar", "Get one calendar by API v3 ID.", idSchema("calendar_id")),
  readTool("itcons_list_holidays", "List holidays from one private Itcons.app calendar within an inclusive date range of at most 366 days.", objectSchema({
    calendar_id: integerProperty("Calendar ID."),
    date_from: stringProperty("First date to include in YYYY-MM-DD format."),
    date_to: stringProperty("Last date to include in YYYY-MM-DD format.")
  }, ["calendar_id", "date_from", "date_to"])),
  readTool("itcons_get_working_days", "Calculate working and non-working days from one private Itcons.app calendar within an inclusive date range of at most 366 days.", objectSchema({
    calendar_id: integerProperty("Calendar ID."),
    date_from: stringProperty("First date to include in YYYY-MM-DD format."),
    date_to: stringProperty("Last date to include in YYYY-MM-DD format.")
  }, ["calendar_id", "date_from", "date_to"])),
  readTool("itcons_list_leave_types", "List leave types from Itcons.app API v3.", paginationSchema()),

  readTool("itcons_list_work_report_templates", "List work report templates from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_list_work_report_models", "Compatibility alias for reports-only clients. Lists API v3 work report templates.", paginationSchema()),
  readTool("itcons_get_work_report_template", "Get one work report template by API v3 ID.", idSchema("template_id")),
  readTool("itcons_list_work_reports", "List work reports from Itcons.app API v3.", objectSchema({
    ...paginationSchema(100).properties,
    is_archived: booleanProperty("Filter archived work reports."),
    template_id: integerProperty("Filter by template ID."),
    project_id: integerProperty("Filter by project ID."),
    project_erpid: stringProperty("Filter by project ERP identifier."),
    user_id: integerProperty("Filter by user ID."),
    user_erpid: stringProperty("Filter by user ERP identifier."),
    status_id: integerProperty("Filter by status ID."),
    status: stringProperty("Filter by status slug."),
    date: stringProperty("Compatibility alias for an exact report date in YYYY-MM-DD or DD/MM/YYYY format."),
    date_from: stringProperty("Filter reports on or after this date in YYYY-MM-DD format."),
    date_to: stringProperty("Filter reports on or before this date in YYYY-MM-DD format."),
    updated_since: stringProperty("Filter reports updated since this ISO 8601 date/time.")
  })),
  readTool("itcons_search_work_reports", "Compatibility alias for reports-only clients. Search API v3 work reports by ID or template/model ID.", objectSchema({
    id: integerProperty("Optional work report ID."),
    model: integerProperty("Optional legacy model/template ID."),
    template_id: integerProperty("Optional work report template ID."),
    limit: integerProperty("Maximum items to return.", 1, 500, 100),
    page: integerProperty("Page number.", 1, undefined, 1)
  })),
  readTool("itcons_get_work_report", "Get one work report by API v3 ID.", idSchema("work_report_id")),
  readTool("itcons_get_work_report_as_post_payload", "Get a work report converted to the API v3 create payload shape.", idSchema("work_report_id")),
  readTool("itcons_list_work_reports_by_date", "List work reports matching a date in Itcons.app API v3.", objectSchema({
    date: stringProperty("Report date in YYYY-MM-DD or DD/MM/YYYY format."),
    model: integerProperty("Optional legacy model/template ID."),
    template_id: integerProperty("Optional work report template ID."),
    limit: integerProperty("Maximum items to return.", 1, 500, 100),
    page: integerProperty("Page number.", 1, undefined, 1)
  }, ["date"])),
  readTool("itcons_list_today_work_reports", "List today's work reports in Itcons.app API v3.", objectSchema({
    model: integerProperty("Optional legacy model/template ID."),
    template_id: integerProperty("Optional work report template ID."),
    limit: integerProperty("Maximum items to return.", 1, 500, 100),
    page: integerProperty("Page number.", 1, undefined, 1)
  })),
  writeTool("itcons_create_work_report", "Create a work report in Itcons.app API v3.", objectSchema({
    date: stringProperty("Report date in YYYY-MM-DD format."),
    identifier: integerProperty("Optional custom numeric identifier."),
    template_id: integerProperty("Work report template ID."),
    project_id: integerProperty("Project ID."),
    user_id: integerProperty("User ID."),
    notify: booleanProperty("Whether to notify after creation.", false),
    fields: arrayProperty("Header field values.", looseObjectSchema()),
    lines: arrayProperty("Report lines.", looseObjectSchema()),
    notes: arrayProperty("Report notes.", looseObjectSchema())
  }, ["date", "template_id"])),
  writeTool("itcons_update_work_report_metadata", "Patch work report metadata in Itcons.app API v3.", patchSchema("work_report_id")),
  writeTool("itcons_replace_work_report_content", "Replace work report fields, lines and notes in Itcons.app API v3.", objectSchema({
    work_report_id: integerProperty("Work report ID."),
    fields: arrayProperty("Replacement header field values.", looseObjectSchema()),
    lines: arrayProperty("Replacement report lines.", looseObjectSchema()),
    notes: arrayProperty("Replacement report notes.", looseObjectSchema())
  }, ["work_report_id"])),

  readTool("itcons_list_work_order_types", "List work order types from Itcons.app API v3.", paginationSchema()),
  readTool("itcons_get_work_order_type", "Get one work order type by API v3 ID.", idSchema("work_order_type_id")),
  readTool("itcons_list_work_orders", "List work orders from Itcons.app API v3.", objectSchema({
    ...paginationSchema().properties,
    search: stringProperty("Filter work orders by text search."),
    identifier: integerProperty("Filter by displayed work order identifier."),
    erpid: stringProperty("Filter by work order ERP identifier."),
    project_id: integerProperty("Filter by project ID."),
    project_erpid: stringProperty("Filter by project ERP identifier."),
    work_order_type_id: integerProperty("Filter by work order type ID."),
    status_id: integerProperty("Filter by status ID."),
    area_id: integerProperty("Filter by area ID."),
    user_id: integerProperty("Filter by assigned user ID."),
    updated_since: stringProperty("Filter work orders updated since this ISO 8601 date/time."),
    started_from: stringProperty("Filter work orders started on or after this ISO 8601 date/time."),
    started_to: stringProperty("Filter work orders started on or before this ISO 8601 date/time."),
    finished_from: stringProperty("Filter work orders finished on or after this ISO 8601 date/time."),
    finished_to: stringProperty("Filter work orders finished on or before this ISO 8601 date/time."),
    is_archived: booleanProperty("Filter archived work orders when supported by the installation.")
  })),
  readTool("itcons_get_work_order", "Get one work order by API v3 ID.", idSchema("work_order_id")),
  writeTool("itcons_create_work_order", "Create a work order in Itcons.app API v3.", objectSchema({
    name: stringProperty("Work order name."),
    work_order_type_id: integerProperty("Work order type ID."),
    project_id: nullableIntegerProperty("Project ID."),
    status_id: integerProperty("Status ID."),
    erpid: stringProperty("ERP identifier."),
    priority: enumProperty("Priority.", PRIORITIES),
    planned_started_at: stringProperty("Planned start date/time."),
    planned_finished_at: stringProperty("Planned finish date/time."),
    note: stringProperty("Work order note."),
    users: arrayProperty("Assigned users. Each item may contain id, email or erpid.", looseObjectSchema()),
    locations: arrayProperty("Locations with latitude and longitude.", looseObjectSchema())
  }, ["name", "work_order_type_id"])),
  writeTool("itcons_update_work_order", "Patch a work order in Itcons.app API v3.", patchSchema("work_order_id")),

  readTool("itcons_list_statuses", "List work order statuses. API v3 currently exposes status IDs through work order data/types, so this returns a local compatibility map.", objectSchema({}))
];

const TOOL_HANDLERS = {
  itcons_check_connection: (args, context) => listResource("/work-order-types", { limit: 1 }, context),

  itcons_list_users: (args, context) => listResource("/users", args, context),
  itcons_get_user: (args, context) => getResource("/users", args.user_id, context),
  itcons_create_user: (args, context) => createResource("/users", userPayload(args), context),
  itcons_update_user: (args, context) => patchResource("/users", args.user_id, args.payload, context),

  itcons_list_clients: (args, context) => listResource("/clients", args, context),
  itcons_get_client: (args, context) => getResource("/clients", args.client_id, context),
  itcons_create_client: (args, context) => createResource("/clients", args, context),
  itcons_update_client: (args, context) => patchResource("/clients", args.client_id, args.payload, context),

  itcons_list_projects: (args, context) => context.toolProfile === "reports-only"
    ? listSafeProjects(args, context)
    : listResource("/projects", args, context),
  itcons_get_project: (args, context) => getResource("/projects", args.project_id, context),
  itcons_create_project: (args, context) => createResource("/projects", args, context),
  itcons_update_project: (args, context) => patchResource("/projects", args.project_id, args.payload, context),

  itcons_list_categories: (args, context) => listResource("/categories", args, context),
  itcons_get_category: (args, context) => getResource("/categories", args.category_id, context),
  itcons_create_category: (args, context) => createResource("/categories", args, context),
  itcons_update_category: (args, context) => patchResource("/categories", args.category_id, args.payload, context),

  itcons_list_resources: (args, context) => listResource("/resources", args, context),
  itcons_get_resource: (args, context) => getResource("/resources", args.resource_id, context),
  itcons_create_resource: (args, context) => createResource("/resources", args, context),
  itcons_update_resource: (args, context) => patchResource("/resources", args.resource_id, args.payload, context),

  itcons_list_calendars: (args, context) => context.toolProfile === "reports-only"
    ? listSafeCalendars(args, context)
    : listResource("/calendars", args, context),
  itcons_get_calendar: (args, context) => getResource("/calendars", args.calendar_id, context),
  itcons_list_holidays: (args, context) => listCalendarHolidays(args, context),
  itcons_get_working_days: (args, context) => getCalendarWorkingDays(args, context),
  itcons_list_leave_types: (args, context) => context.toolProfile === "reports-only"
    ? listSafeLeaveTypes(args, context)
    : listResource("/leave-types", args, context),

  itcons_list_work_report_templates: (args, context) => listResource("/work-report-templates", args, context),
  itcons_list_work_report_models: (args, context) => listResource("/work-report-templates", args, context),
  itcons_get_work_report_template: (args, context) => getResource("/work-report-templates", args.template_id, context),
  itcons_list_work_reports: (args, context) => listResource("/work-reports", buildWorkReportListQuery(args), context),
  itcons_search_work_reports: (args, context) => searchWorkReports(args, context),
  itcons_get_work_report: (args, context) => getResource("/work-reports", args.work_report_id, context),
  itcons_get_work_report_as_post_payload: (args, context) => apiRequest(`/work-reports/${args.work_report_id}/as-post-payload`, {}, context),
  itcons_list_work_reports_by_date: (args, context) => listResource("/work-reports", buildWorkReportListQuery({
    ...args,
    date: normalizeReportDate(args.date)
  }), context),
  itcons_list_today_work_reports: (args, context) => listResource("/work-reports", buildWorkReportListQuery({
    ...args,
    date: todayReportDate(context)
  }), context),
  itcons_create_work_report: (args, context) => createResource("/work-reports", args, context),
  itcons_update_work_report_metadata: (args, context) => patchResource("/work-reports", args.work_report_id, args.payload, context),
  itcons_replace_work_report_content: (args, context) => patchResource("/work-reports", args.work_report_id, pick(args, ["fields", "lines", "notes"]), context),

  itcons_list_work_order_types: (args, context) => listResource("/work-order-types", args, context),
  itcons_get_work_order_type: (args, context) => getResource("/work-order-types", args.work_order_type_id, context),
  itcons_list_work_orders: (args, context) => context.toolProfile === "reports-only"
    ? listSafeWorkOrders(args, context)
    : listResource("/work-orders", args, context),
  itcons_get_work_order: (args, context) => getResource("/work-orders", args.work_order_id, context),
  itcons_create_work_order: (args, context) => createResource("/work-orders", args, context),
  itcons_update_work_order: (args, context) => patchResource("/work-orders", args.work_order_id, args.payload, context),

  itcons_list_statuses: () => ({
    note: "API v3 does not document a standalone statuses endpoint in the Postman collection.",
    work_order_statuses: [
      { id: 4, slug: "pending", legacy_slug: "pendiente" },
      { id: 5, slug: "in_progress", legacy_slug: "en-ejecucion" },
      { id: 6, slug: "completed", legacy_slug: "completado" },
      { id: 7, slug: "cancelled", legacy_slug: "anulado" }
    ]
  })
};

let cachedToken = process.env.ITCONS_TOKEN || null;

export function createItconsMcpServer(options = {}) {
  const toolProfile = normalizeToolProfile(options.toolProfile);
  const allowedToolNames = allowedToolNameSet(toolProfile);
  const server = new Server(
    {
      name: "itcons-app-mcp-server",
      version: "3.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.filter((tool) => allowedToolNames.has(tool.name))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments || {};
    const context = { ...itconsContext(extra), toolProfile };

    try {
      const handler = TOOL_HANDLERS[request.params.name];

      if (!handler || !allowedToolNames.has(request.params.name)) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      return toolResult(await handler(args, context));
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

export function normalizeToolProfile(value) {
  return value === "reports-only" ? "reports-only" : "full";
}

export function reportsOnlyToolNames() {
  return [...REPORTS_ONLY_TOOL_NAMES];
}

function allowedToolNameSet(toolProfile) {
  if (toolProfile === "reports-only") {
    return new Set(REPORTS_ONLY_TOOL_NAMES);
  }

  return new Set(TOOL_DEFINITIONS
    .map((tool) => tool.name)
    .filter((toolName) => !REPORTS_COMPAT_TOOL_NAMES.includes(toolName)));
}

function readTool(name, description, inputSchema) {
  return {
    name,
    description,
    annotations: READ_ONLY_PRIVATE_TOOL,
    securitySchemes: OAUTH_SECURITY_SCHEMES,
    _meta: {
      securitySchemes: OAUTH_SECURITY_SCHEMES
    },
    inputSchema: objectSchema(inputSchema.properties || inputSchema, inputSchema.required || [])
  };
}

function writeTool(name, description, inputSchema) {
  return {
    name,
    description,
    annotations: WRITE_PRIVATE_TOOL,
    securitySchemes: OAUTH_SECURITY_SCHEMES,
    _meta: {
      securitySchemes: OAUTH_SECURITY_SCHEMES
    },
    inputSchema: objectSchema(inputSchema.properties || inputSchema, inputSchema.required || [])
  };
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function looseObjectSchema() {
  return {
    type: "object",
    additionalProperties: true
  };
}

function patchSchema(idName) {
  return objectSchema({
    [idName]: integerProperty(`${idName} value.`),
    payload: {
      type: "object",
      description: "API v3 PATCH body. Use the exact fields documented by the Postman collection.",
      additionalProperties: true
    }
  }, [idName, "payload"]);
}

function idSchema(idName) {
  return objectSchema({
    [idName]: integerProperty(`${idName} value.`)
  }, [idName]);
}

function paginationSchema(defaultLimit = 50) {
  return objectSchema({
    page: integerProperty("Page number.", 1, undefined, 1),
    limit: integerProperty("Maximum items to return.", 1, 500, defaultLimit)
  });
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

function nullableIntegerProperty(description) {
  return {
    oneOf: [
      { type: "integer" },
      { type: "null" }
    ],
    description
  };
}

function booleanProperty(description, defaultValue) {
  return compact({
    type: "boolean",
    description,
    default: defaultValue
  });
}

function enumProperty(description, values, defaultValue) {
  return compact({
    type: "string",
    description,
    enum: values,
    default: defaultValue
  });
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

async function listResource(pathname, args = {}, context = {}) {
  const query = dropUndefined({
    page: args.page ?? 1,
    limit: args.limit ?? 50,
    is_archived: args.is_archived,
    search: args.search,
    erpid: args.erpid,
    identifier: args.identifier,
    client_id: args.client_id,
    client_erpid: args.client_erpid,
    include_subcategories: args.include_subcategories,
    template_id: args.template_id,
    project_id: args.project_id,
    project_erpid: args.project_erpid,
    area_id: args.area_id,
    user_id: args.user_id,
    user_erpid: args.user_erpid,
    date_from: args.date_from,
    date_to: args.date_to,
    updated_since: args.updated_since,
    started_from: args.started_from,
    started_to: args.started_to,
    finished_from: args.finished_from,
    finished_to: args.finished_to,
    work_order_type_id: args.work_order_type_id,
    status_id: args.status_id,
    status: args.status
  });

  return apiRequest(pathname, { query }, context);
}

async function listCalendarHolidays(args, context = {}) {
  const range = calendarDateRange(args.date_from, args.date_to);
  const response = await getResource("/calendars", args.calendar_id, context);
  const calendar = response?.data || response;
  const holidays = Array.isArray(calendar?.holidays) ? calendar.holidays : [];

  return {
    calendar: pick(calendar || {}, ["id", "name", "enabled"]),
    date_from: range.dateFrom,
    date_to: range.dateTo,
    holidays: holidays
      .filter((holiday) => isDateInRange(holiday?.date, range))
      .map((holiday) => pick(holiday, ["name", "date"]))
      .sort((left, right) => String(left.date).localeCompare(String(right.date)))
  };
}

async function getCalendarWorkingDays(args, context = {}) {
  const range = calendarDateRange(args.date_from, args.date_to);
  const response = await getResource("/calendars", args.calendar_id, context);
  const calendar = response?.data || response;
  const holidays = new Map((Array.isArray(calendar?.holidays) ? calendar.holidays : [])
    .filter((holiday) => isDateInRange(holiday?.date, range))
    .map((holiday) => [holiday.date, holiday.name]));
  const workingDays = [];
  const nonWorkingDays = [];

  for (const date of eachDateInRange(range)) {
    const day = date.getUTCDay();
    const dateText = isoDate(date);
    const holidayName = holidays.get(dateText);
    const weekendOff = (day === 6 && calendar?.saturday_day_off === true) ||
      (day === 0 && calendar?.sunday_day_off === true);

    if (holidayName || weekendOff) {
      nonWorkingDays.push({
        date: dateText,
        reason: holidayName ? "holiday" : "weekly_day_off",
        ...(holidayName ? { name: holidayName } : {})
      });
    } else {
      workingDays.push(dateText);
    }
  }

  return {
    calendar: pick(calendar || {}, ["id", "name", "enabled", "saturday_day_off", "sunday_day_off"]),
    date_from: range.dateFrom,
    date_to: range.dateTo,
    total_days: range.totalDays,
    working_days_count: workingDays.length,
    non_working_days_count: nonWorkingDays.length,
    working_days: workingDays,
    non_working_days: nonWorkingDays
  };
}

async function listSafeProjects(args, context = {}) {
  const response = await listResource("/projects", { ...args, limit: boundedListLimit(args.limit) }, context);
  return mapResponseData(response, (project) => ({
    ...pick(project, ["id", "erpid", "name", "is_archived", "started_at", "finished_at"]),
    ...(project?.status ? { status: safeReference(project.status) } : {})
  }));
}

async function listSafeWorkOrders(args, context = {}) {
  const response = await listResource("/work-orders", { ...args, limit: boundedListLimit(args.limit) }, context);
  return mapResponseData(response, (workOrder) => ({
    ...pick(workOrder, [
      "id", "erpid", "identifier", "name", "priority", "planned_started_at", "planned_finished_at",
      "started_at", "completed_at", "rejected_at", "unit_measurement_value", "estimated_duration"
    ]),
    ...(workOrder?.status ? { status: safeReference(workOrder.status) } : {}),
    ...(workOrder?.work_order_type ? { work_order_type: safeReference(workOrder.work_order_type) } : {}),
    ...(workOrder?.project ? { project: safeReference(workOrder.project) } : {}),
    ...(workOrder?.area ? { area: safeReference(workOrder.area) } : {})
  }));
}

async function listSafeCalendars(args, context = {}) {
  const response = await listResource("/calendars", { ...args, limit: boundedListLimit(args.limit) }, context);
  return mapResponseData(response, (calendar) => pick(calendar, [
    "id", "name", "enabled", "saturday_day_off", "sunday_day_off"
  ]));
}

async function listSafeLeaveTypes(args, context = {}) {
  const response = await listResource("/leave-types", { ...args, limit: boundedListLimit(args.limit) }, context);
  return mapResponseData(response, (leaveType) => pick(leaveType, ["id", "name", "day_type", "enabled"]));
}

function safeReference(value) {
  return pick(value || {}, ["id", "erpid", "name", "slug"]);
}

function mapResponseData(response, mapper) {
  if (Array.isArray(response?.data)) return { ...response, data: response.data.map(mapper) };
  if (response?.data && typeof response.data === "object") return { ...response, data: mapper(response.data) };
  if (Array.isArray(response)) return response.map(mapper);
  return response;
}

function boundedListLimit(value) {
  const limit = Number(value ?? 50);
  return Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 50;
}

function calendarDateRange(dateFrom, dateTo) {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(String(dateFrom)) || !datePattern.test(String(dateTo))) {
    throw new Error("date_from and date_to must use YYYY-MM-DD format.");
  }

  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  const end = new Date(`${dateTo}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || isoDate(start) !== dateFrom || isoDate(end) !== dateTo) {
    throw new Error("date_from and date_to must be valid calendar dates.");
  }
  if (end < start) throw new Error("date_to must be on or after date_from.");

  const totalDays = Math.floor((end - start) / 86400000) + 1;
  if (totalDays > 366) throw new Error("The calendar date range cannot exceed 366 days.");
  return { start, end, dateFrom, dateTo, totalDays };
}

function isDateInRange(value, range) {
  return typeof value === "string" && value >= range.dateFrom && value <= range.dateTo;
}

function eachDateInRange(range) {
  const dates = [];
  for (let time = range.start.getTime(); time <= range.end.getTime(); time += 86400000) dates.push(new Date(time));
  return dates;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function getResource(pathname, id, context = {}) {
  assertId(id);
  return apiRequest(`${pathname}/${id}`, {}, context);
}

async function createResource(pathname, body, context = {}) {
  return apiRequest(pathname, {
    method: "POST",
    body: dropUndefined(body)
  }, context);
}

async function patchResource(pathname, id, body, context = {}) {
  assertId(id);
  return apiRequest(`${pathname}/${id}`, {
    method: "PATCH",
    body: dropUndefined(body)
  }, context);
}

function userPayload(args) {
  const payload = dropUndefined(args);

  if (!payload.role) {
    payload.role = "mobile_user";
  }

  return payload;
}

export function buildWorkReportListQuery(args) {
  const exactDate = args.date === undefined ? undefined : normalizeReportDate(args.date);

  return dropUndefined({
    page: args.page ?? 1,
    limit: args.limit ?? 100,
    is_archived: args.is_archived,
    template_id: args.template_id ?? args.model,
    project_id: args.project_id,
    project_erpid: args.project_erpid,
    user_id: args.user_id,
    user_erpid: args.user_erpid,
    status_id: args.status_id,
    status: args.status,
    date_from: args.date_from === undefined ? exactDate : normalizeReportDate(args.date_from),
    date_to: args.date_to === undefined ? exactDate : normalizeReportDate(args.date_to),
    updated_since: args.updated_since
  });
}

async function searchWorkReports(args, context = {}) {
  if (args.id) {
    return getResource("/work-reports", args.id, context);
  }

  return listResource("/work-reports", buildWorkReportListQuery(args), context);
}

async function apiRequest(pathname, options = {}, context = {}) {
  const token = await getToken(context);
  const url = buildApiUrl(pathname, options.query, context);
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

function buildApiUrl(pathname, query = {}, context = {}) {
  const base = apiBaseUrl(context);
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = String(pathname).replace(/^\/+/, "");
  const url = new URL(`${cleanBase}/${cleanPath}`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
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

  const loginUrl = process.env.ITCONS_LOGIN_URL || "https://" + domain + ".itcons.app/api/login_check";
  const response = await fetch(loginUrl, {
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
    return normalizeApiBaseUrl(context.apiBaseUrl);
  }

  if (process.env.ITCONS_API_BASE_URL) {
    return normalizeApiBaseUrl(process.env.ITCONS_API_BASE_URL);
  }

  const domain = context.domain || requiredEnv("ITCONS_DOMAIN");

  return `https://${domain}.itcons.app/api/v3`;
}

function normalizeApiBaseUrl(value) {
  const clean = String(value).replace(/\/+$/, "");

  if (clean.endsWith("/api")) {
    return `${clean}/v3`;
  }

  return clean;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeReportDate(date) {
  const text = String(date || "").trim();
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  return text;
}

function todayReportDate(context = {}) {
  const timezone = context.timezone || process.env.TZ || process.env.ITCONS_TIMEZONE || "Europe/Madrid";

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function dropUndefined(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]).filter(([, entry]) => entry !== undefined));
}

function assertId(value) {
  if (!Number.isInteger(Number(value)) || Number(value) <= 0) {
    throw new Error("A positive numeric ID is required.");
  }
}

async function main() {
  const server = createItconsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
