#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildWorkReportListQuery } from "../src/index.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "index.js");
const expectedTools = [
  "itcons_check_connection",
  "itcons_list_users",
  "itcons_get_user",
  "itcons_create_user",
  "itcons_update_user",
  "itcons_list_clients",
  "itcons_get_client",
  "itcons_create_client",
  "itcons_update_client",
  "itcons_list_projects",
  "itcons_get_project",
  "itcons_create_project",
  "itcons_update_project",
  "itcons_list_categories",
  "itcons_get_category",
  "itcons_create_category",
  "itcons_update_category",
  "itcons_list_resources",
  "itcons_get_resource",
  "itcons_create_resource",
  "itcons_update_resource",
  "itcons_list_calendars",
  "itcons_get_calendar",
  "itcons_list_leave_types",
  "itcons_list_work_report_templates",
  "itcons_get_work_report_template",
  "itcons_list_work_reports",
  "itcons_get_work_report",
  "itcons_get_work_report_as_post_payload",
  "itcons_list_work_reports_by_date",
  "itcons_list_today_work_reports",
  "itcons_create_work_report",
  "itcons_update_work_report_metadata",
  "itcons_replace_work_report_content",
  "itcons_list_work_order_types",
  "itcons_get_work_order_type",
  "itcons_list_work_orders",
  "itcons_get_work_order",
  "itcons_create_work_order",
  "itcons_update_work_order",
  "itcons_list_statuses"
];
const readOnlyTools = new Set(expectedTools.filter((tool) => {
  return !tool.includes("_create_") &&
    !tool.includes("_update_") &&
    !tool.includes("_replace_");
}));
const writeTools = new Set(expectedTools.filter((tool) => !readOnlyTools.has(tool)));

const exactDateQuery = buildWorkReportListQuery({ date: "16/10/2026", limit: 25 });
if (
  exactDateQuery.date_from !== "2026-10-16" ||
  exactDateQuery.date_to !== "2026-10-16" ||
  "date" in exactDateQuery
) {
  throw new Error("Exact work report dates must map to API v3 date_from/date_to filters.");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: process.env
});

const client = new Client(
  {
    name: "itcons-app-mcp-smoke",
    version: "0.5.0"
  },
  {
    capabilities: {}
  }
);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const toolNames = tools.map((tool) => tool.name);
  const missingTools = expectedTools.filter((tool) => !toolNames.includes(tool));
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

  if (missingTools.length > 0) {
    throw new Error(`Missing expected tools: ${missingTools.join(", ")}`);
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

  console.log(`OK: discovered ${toolNames.length} tools.`);

  if (process.env.ITCONS_SMOKE_LIVE === "1") {
    const result = await client.callTool({
      name: "itcons_check_connection",
      arguments: {}
    });

    if (result.isError) {
      throw new Error(result.content?.[0]?.text || "Live check failed.");
    }

    console.log("OK: live Itcons.app connection check passed.");

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.ITCONS_TIMEZONE || "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
    const reportsResult = await client.callTool({
      name: "itcons_list_work_reports_by_date",
      arguments: { date: today, limit: 100 }
    });

    if (reportsResult.isError) {
      throw new Error(reportsResult.content?.[0]?.text || "Live work report date filter failed.");
    }

    const reportsBody = JSON.parse(reportsResult.content?.[0]?.text || "null");
    const reports = Array.isArray(reportsBody?.data)
      ? reportsBody.data
      : reportsBody?.data
        ? [reportsBody.data]
        : Array.isArray(reportsBody)
          ? reportsBody
          : [];

    if (reports.some((report) => report.date !== today)) {
      throw new Error("Work report date filter returned reports from another date.");
    }

    console.log(`OK: live work report date filter returned ${reports.length} matching report(s).`);
  }
} finally {
  await client.close();
}
