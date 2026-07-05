import http from "http";
import https from "https";
import { URL } from "url";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { callMoonshot } from "../services/moonshot.js";

// ────────────────────── 日志 ──────────────────────

// 日志文件路径：优先用环境变量，否则放系统临时目录（跨平台、无需权限处理）
const LOG_FILE =
  process.env.VISION_MCP_LOG_FILE ||
  path.join(os.tmpdir(), "vision-mcp-proxy.log");
const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB，超过后清空旧日志

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.error(line.trim());
  fs.stat(LOG_FILE, (statErr, stats) => {
    if (statErr || stats.size < LOG_MAX_SIZE) {
      fs.appendFile(LOG_FILE, line, () => {});
    } else {
      // 超过大小限制，覆盖写入（保留最近日志，丢弃旧的）
      fs.writeFile(LOG_FILE, line, () => {});
    }
  });
}

// ────────────────────── 配置 ──────────────────────

// 代理监听端口：从 ANTHROPIC_BASE_URL 解析，与 Claude Code 端保持一致
// 没设 ANTHROPIC_BASE_URL 时用默认 8787（纯 MCP 工具模式，代理无人连接）
function getProxyPort(): number {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (baseUrl) {
    try {
      const port = new URL(baseUrl).port;
      if (port) return parseInt(port, 10);
    } catch {
      // 忽略解析错误，回退到默认
    }
  }
  return 8787;
}
const PROXY_PORT = getProxyPort();
// 代理转发目标：用户必须设置 UPSTREAM_BASE_URL，否则代理功能不可用（MCP 工具仍可用）
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || "";
const UPSTREAM_AUTH_TOKEN =
  process.env.UPSTREAM_AUTH_TOKEN ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  "";
const IMAGE_DESC_PROMPT =
  process.env.IMAGE_DESC_PROMPT ||
  "请详细描述这张图片的内容。如果是图表/截图，请提取关键信息；如果包含文字，请提取文字内容；如果是 UI 界面，请描述界面元素和布局。描述要简洁准确。";

// ────────────────────── 图片识别 ──────────────────────

async function describeImage(
  base64Data: string,
  mimeType: string
): Promise<string> {
  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  const apiKey = process.env.MOONSHOT_API_KEY || "";
  if (!apiKey) {
    throw new Error("MOONSHOT_API_KEY 未设置");
  }

  const response = await callMoonshot({
    apiKey,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          { type: "text", text: IMAGE_DESC_PROMPT },
        ],
      },
    ],
    maxTokens: 2048,
  });

  const description = response.choices?.[0]?.message?.content || "";
  if (!description) {
    throw new Error("Moonshot API 返回空内容");
  }
  return description;
}

// ────────────────────── 处理 messages ──────────────────────

interface ContentBlock {
  type: string;
  source?: { type?: string; media_type?: string; data?: string };
  text?: string;
  image_url?: { url: string };
  // tool_result 的 content 可能是 ContentBlock 数组或字符串
  content?: unknown;
  [key: string]: unknown;
}

interface Message {
  role: string;
  content: string | ContentBlock[];
}

async function processContent(
  content: string | ContentBlock[]
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  // 日志：记录所有 block 类型，方便排查
  const blockTypes = content.map((b) => b?.type || "unknown");
  log(`[image-proxy] content blocks: ${JSON.stringify(blockTypes)}`);

  const newContent: ContentBlock[] = [];
  for (const block of content) {
    // 格式1: Anthropic 标准 {"type":"image","source":{"type":"base64",...}}
    if (block?.type === "image" && block.source?.type === "base64") {
      const { media_type, data } = block.source as { media_type: string; data: string };
      try {
        const description = await describeImage(data, media_type);
        newContent.push({
          type: "text",
          text: `[以下是用户粘贴的图片内容描述]\n${description}\n[图片描述结束]`,
        });
        log(`[image-proxy] 图片已识别 (${media_type}, ${Math.round((data.length * 0.75) / 1024)} KB)`);
      } catch (err) {
        log(`[image-proxy] 图片识别失败: ${(err as Error).message}`);
        newContent.push({
          type: "text",
          text: `[图片识别失败: ${(err as Error).message}]`,
        });
      }
    }
    // 格式2: OpenAI 风格 {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
    else if (
      block?.type === "image_url" &&
      block.image_url?.url?.startsWith("data:image")
    ) {
      const url = block.image_url.url;
      const match = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
      if (match) {
        const [, media_type, data] = match;
        try {
          const description = await describeImage(data, media_type);
          newContent.push({
            type: "text",
            text: `[以下是截图内容描述]\n${description}\n[图片描述结束]`,
          });
          log(`[image-proxy] image_url 图片已识别 (${media_type})`);
        } catch (err) {
          log(`[image-proxy] image_url 图片识别失败: ${(err as Error).message}`);
          newContent.push({
            type: "text",
            text: `[图片识别失败: ${(err as Error).message}]`,
          });
        }
      } else {
        newContent.push(block);
      }
    }
    // 格式3: tool_result 里嵌套图片（MCP 工具返回的截图）
    else if (block?.type === "tool_result" && Array.isArray(block.content)) {
      const toolContent = block.content as ContentBlock[];
      const processed = await processContent(toolContent);
      newContent.push({ ...block, content: processed } as ContentBlock);
    }
    else if (block?.type === "image" && block.source && !block.source.type?.startsWith("base64")) {
      log(`[image-proxy] 未识别的 image source type: ${block.source.type}`);
      newContent.push(block);
    }
    else {
      newContent.push(block);
    }
  }
  return newContent;
}

async function processMessages(messages: Message[]): Promise<Message[]> {
  if (!Array.isArray(messages)) return messages;
  for (const message of messages) {
    if (message && typeof message === "object" && message.content !== undefined) {
      message.content = await processContent(message.content) as string | ContentBlock[];
    }
  }
  return messages;
}

// ────────────────────── 转发请求 ──────────────────────

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string | null
): void {
  const baseUrl = new URL(UPSTREAM_BASE_URL);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const fullPath = basePath + (req.url || "");
  const isHttps = baseUrl.protocol === "https:";
  const lib = isHttps ? https : http;

  const headers = { ...req.headers } as Record<string, string>;
  delete headers["host"];
  delete headers["content-length"];
  // body 已被解压/修改，必须删除原压缩标记和逐跳头，否则上游会尝试解压明文导致失败
  delete headers["content-encoding"];
  delete headers["transfer-encoding"];
  headers["host"] = baseUrl.host;
  if (UPSTREAM_AUTH_TOKEN) {
    headers["authorization"] = `Bearer ${UPSTREAM_AUTH_TOKEN}`;
    headers["x-api-key"] = UPSTREAM_AUTH_TOKEN;
  }
  if (body) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  const options: https.RequestOptions = {
    method: req.method,
    hostname: baseUrl.hostname,
    port: baseUrl.port || (isHttps ? 443 : 80),
    path: fullPath,
    headers,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err: Error) => {
    log(`[image-proxy] 转发失败: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { type: "proxy_error", message: err.message } })
      );
    }
  });

  if (body) {
    proxyReq.write(body);
  } else {
    req.pipe(proxyReq);
  }
  proxyReq.end();
}

// ────────────────────── 端口清理 ──────────────────────

function killProcessOnPort(port: number): boolean {
  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore", timeout: 5000 }
      );
    } else if (process.platform === "darwin" || process.platform === "linux") {
      // macOS/Linux: lsof 找到占用端口的 PID 并 kill -9
      // lsof 不存在时静默失败，|| true 保证命令返回 0
      execSync(`lsof -ti :${port} 2>/dev/null | xargs kill -9 2>/dev/null || true`, {
        stdio: "ignore",
        timeout: 5000,
      });
    } else {
      return false;
    }
    log(`[image-proxy] 已清理占用端口 ${port} 的旧进程`);
    return true;
  } catch {
    // 忽略错误
  }
  return false;
}

// ────────────────────── 启动代理 ──────────────────────

export function startImageProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!UPSTREAM_BASE_URL) {
      log("[image-proxy] 未设置 UPSTREAM_BASE_URL，代理功能不可用（MCP 工具仍可用）");
      resolve();
      return;
    }

    const server = http.createServer(async (req, res) => {
      const isMessagesEndpoint =
        req.method === "POST" && (req.url || "").includes("/v1/messages");

      if (!isMessagesEndpoint) {
        forwardRequest(req, res, null);
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const buffer = Buffer.concat(chunks);
        const contentEncoding = (req.headers["content-encoding"] || "").toLowerCase();

        // 解压请求体（支持 gzip / deflate / br），否则 JSON.parse 会失败
        let rawBody: string;
        try {
          if (contentEncoding.includes("gzip")) {
            rawBody = zlib.gunzipSync(buffer).toString("utf8");
          } else if (contentEncoding.includes("deflate")) {
            rawBody = zlib.inflateSync(buffer).toString("utf8");
          } else if (contentEncoding.includes("br")) {
            rawBody = zlib.brotliDecompressSync(buffer).toString("utf8");
          } else {
            rawBody = buffer.toString("utf8");
          }
        } catch (err) {
          log(`[image-proxy] 请求体解压失败: ${(err as Error).message}`);
          if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { type: "proxy_error", message: "请求体解压失败" },
              })
            );
          }
          return;
        }

        try {
          const requestData = JSON.parse(rawBody);
          let hasImage = false;
          if (Array.isArray(requestData.messages)) {
            for (const msg of requestData.messages) {
              if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  // 检测所有可能的图片格式
                  if (
                    block?.type === "image" ||
                    block?.type === "image_url" ||
                    (block?.type === "tool_result" && Array.isArray(block.content))
                  ) {
                    hasImage = true;
                    break;
                  }
                }
              }
              if (hasImage) break;
            }
          }

          if (hasImage) {
            log(`[image-proxy] 检测到图片，开始识别...`);
            requestData.messages = await processMessages(requestData.messages);
            const newBody = JSON.stringify(requestData);
            forwardRequest(req, res, newBody);
          } else {
            forwardRequest(req, res, rawBody);
          }
        } catch (err) {
          log(`[image-proxy] 处理失败: ${(err as Error).message}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: { type: "proxy_error", message: (err as Error).message },
              })
            );
          }
        }
      });

      req.on("error", (err: Error) => {
        log(`[image-proxy] 请求错误: ${err.message}`);
      });
    });

    let retried = false;

    server.on("error", (err: Error) => {
      const msg = err.message;
      if (msg.includes("EADDRINUSE") && !retried) {
        retried = true;
        log(`[image-proxy] 端口 ${PROXY_PORT} 被占用，清理旧进程后重试...`);
        killProcessOnPort(PROXY_PORT);
        setTimeout(() => {
          server.listen(PROXY_PORT, "127.0.0.1");
        }, 1000);
      } else {
        // 其他错误或重试仍失败，不阻塞 MCP 启动
        log(`[image-proxy] 代理启动失败（MCP 工具仍可用）: ${msg}`);
        resolve();
      }
    });

    server.listen(PROXY_PORT, "127.0.0.1", () => {
      log(`[image-proxy] 代理已启动: http://127.0.0.1:${PROXY_PORT}`);
      log(`[image-proxy] 上游 API: ${UPSTREAM_BASE_URL}`);
      resolve();
    });
  });
}
