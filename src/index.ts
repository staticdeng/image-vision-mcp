#!/usr/bin/env node
/**
 * Vision MCP Server
 *
 * 通过视觉模型提供识图能力的 MCP server。
 * 使用 stdio 传输，供 Claude Code 本地调用。
 *
 * 同时启动 HTTP 图片拦截代理：拦截 Claude Code 发往上游 API 的图片请求，
 * 调用视觉模型识别后替换为文字描述，避免 GLM 等纯文本模型 400 报错。
 * 配置 ANTHROPIC_BASE_URL=http://127.0.0.1:8787 即可启用。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDescribeImageTool } from "./tools/describeImage.js";
import { ensureImageProxyRunning } from "./proxy/imageProxy.js";

function getRequiredEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[vision-mcp] 错误: ${name} 环境变量未设置`);
    console.error(`[vision-mcp] ${hint}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  // 0. fail-fast 校验必需的环境变量
  const apiKey = getRequiredEnv(
    "VISION_API_KEY",
    "请在 MCP 配置的 env 里设置 VISION_API_KEY"
  );
  getRequiredEnv(
    "VISION_BASE_URL",
    "请在 MCP 配置的 env 里设置 VISION_BASE_URL（如 https://ark.cn-beijing.volces.com/api/v3）"
  );
  getRequiredEnv(
    "VISION_MODEL",
    "请在 MCP 配置的 env 里设置 VISION_MODEL（视觉模型 ID，如 doubao-seed-2-1-turbo-260628）"
  );

  // 1. 按需拉起独立常驻的 HTTP 图片拦截代理（与 MCP 进程解耦：
  //    代理脱离任何会话独立运行，关掉任意窗口都不影响它）
  try {
    await ensureImageProxyRunning();
  } catch (err) {
    console.error("[vision-mcp] 代理拉起失败（不影响 MCP 功能）:", err);
  }

  // 2. 启动 MCP 服务器
  const server = new McpServer({
    name: "vision-mcp-server",
    version: "1.0.0",
  });

  registerDescribeImageTool(server, () => apiKey);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[vision-mcp] server running via stdio");
}

main().catch((err) => {
  console.error("[vision-mcp] fatal:", err);
  process.exit(1);
});
