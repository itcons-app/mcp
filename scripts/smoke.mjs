#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(rootDir, "src", "index.js");
const expectedTools = [
  "itcons_check_connection",
  "itcons_list_workorder_types",
  "itcons_list_work_report_models",
  "itcons_list_projects",
  "itcons_list_clients",
  "itcons_list_statuses",
  "itcons_list_users",
  "itcons_list_resources",
  "itcons_search_workorders",
  "itcons_list_pending_workorders",
  "itcons_search_work_reports",
  "itcons_list_work_reports_by_date",
  "itcons_list_today_work_reports",
  "itcons_create_workorder",
  "itcons_create_user",
  "itcons_create_project",
  "itcons_create_client"
];

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

  if (missingTools.length > 0) {
    throw new Error(`Missing expected tools: ${missingTools.join(", ")}`);
  }

  if (missingAnnotations.length > 0) {
    throw new Error(`Missing tool annotations: ${missingAnnotations.join(", ")}`);
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
  }
} finally {
  await client.close();
}
