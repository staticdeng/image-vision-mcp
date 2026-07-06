#!/usr/bin/env node
/**
 * 独立常驻的图片拦截代理进程入口。
 *
 * 由第一个 MCP 进程通过 detached spawn 拉起，此后独立于任何 Claude Code 会话
 * 常驻运行：任一会话退出都不影响代理，代理持续服务至自身崩溃或被主动 kill。
 *
 * 启动语义（见 imageProxy.ts 的 startImageProxy）：
 * - 拿到单例锁且 listen 成功 → 常驻服务
 * - 锁已被占（已有代理在跑）→ 安静退出，让在跑的那个继续服务
 * - listen 失败（端口被占）→ 释放锁、退出
 */
import { startImageProxy } from "./imageProxy.js";

startImageProxy().catch((err) => {
  console.error("[vision-mcp-proxy] fatal:", err);
  process.exit(1);
});
