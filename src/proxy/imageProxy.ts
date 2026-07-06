import http from "http";
import https from "https";
import { URL, fileURLToPath } from "url";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import crypto from "crypto";
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

// ────────────────────── 图片识别缓存 ──────────────────────

// Claude Code 每次请求都带完整对话历史，历史里的图片会被反复识别（每张 30-60s）。
// 用 base64 的 sha256 做 key 缓存识别结果，同一张图只识别一次。
// LRU 淘汰：Map 按插入顺序，命中时删除重插移到末尾，超限时删最早的。
const IMAGE_CACHE_MAX = 100;
const imageCache = new Map<string, string>();

function hashImage(base64Data: string): string {
  return crypto.createHash("sha256").update(base64Data).digest("hex").slice(0, 32);
}

function getCachedDescription(base64Data: string): string | null {
  const key = hashImage(base64Data);
  const desc = imageCache.get(key);
  if (desc) {
    imageCache.delete(key);
    imageCache.set(key, desc); // 移到末尾，标记为最近使用
    return desc;
  }
  return null;
}

function setCachedDescription(base64Data: string, description: string): void {
  const key = hashImage(base64Data);
  imageCache.set(key, description);
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey) imageCache.delete(oldestKey);
  }
}

// 失败短期缓存：识别失败（超时/空响应）的图 5 分钟内不重试，
// 避免对话历史里某张图每次请求都卡 60s 超时。过期后允许重试（Moonshot 恢复后能成功）。
const FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const failureCache = new Map<string, number>(); // hash -> 失败时间戳

function getFailureTimestamp(base64Data: string): number | null {
  const key = hashImage(base64Data);
  const ts = failureCache.get(key);
  if (ts === undefined) return null;
  failureCache.delete(key); // LRU 移到末尾
  if (Date.now() - ts > FAILURE_CACHE_TTL_MS) {
    return null; // 过期，不再缓存
  }
  failureCache.set(key, ts);
  return ts;
}

function setFailureTimestamp(base64Data: string): void {
  const key = hashImage(base64Data);
  failureCache.set(key, Date.now());
  if (failureCache.size > IMAGE_CACHE_MAX) {
    const oldestKey = failureCache.keys().next().value;
    if (oldestKey) failureCache.delete(oldestKey);
  }
}

async function describeImage(
  base64Data: string,
  mimeType: string
): Promise<string> {
  // 成功缓存命中：历史消息里反复出现的同一张图不重复调 Moonshot
  const cached = getCachedDescription(base64Data);
  if (cached) {
    log(`[image-proxy] 图片命中缓存，跳过识别`);
    return cached;
  }
  // 失败缓存命中：近期识别失败过的图短期不重试，避免每次请求都卡超时
  if (getFailureTimestamp(base64Data) !== null) {
    log(`[image-proxy] 图片命中失败缓存，跳过重试`);
    throw new Error("图片近期识别失败，跳过重试");
  }

  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  const apiKey = process.env.MOONSHOT_API_KEY || "";
  if (!apiKey) {
    throw new Error("MOONSHOT_API_KEY 未设置");
  }

  try {
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
    setCachedDescription(base64Data, description);
    return description;
  } catch (err) {
    // 失败：记入失败缓存，短期不再重试（让对话继续，不阻塞 60s）
    setFailureTimestamp(base64Data);
    throw err;
  }
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

// 处理单个 content block：图片类型识别后替换为文字，其余原样返回。
// 同层数组的多个图片块由调用方 Promise.all 并行触发，这里只负责单块转换。
async function describeBlock(block: ContentBlock): Promise<ContentBlock> {
  // 格式1: Anthropic 标准 {"type":"image","source":{"type":"base64",...}}
  if (block?.type === "image" && block.source?.type === "base64") {
    const { media_type, data } = block.source as { media_type: string; data: string };
    try {
      const description = await describeImage(data, media_type);
      log(`[image-proxy] 图片已识别 (${media_type}, ${Math.round((data.length * 0.75) / 1024)} KB)`);
      return {
        type: "text",
        text: `[以下是用户粘贴的图片内容描述]\n${description}\n[图片描述结束]`,
      };
    } catch (err) {
      log(`[image-proxy] 图片识别失败: ${(err as Error).message}`);
      return {
        type: "text",
        text: `[图片识别失败: ${(err as Error).message}]`,
      };
    }
  }
  // 格式2: OpenAI 风格 {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
  if (
    block?.type === "image_url" &&
    block.image_url?.url?.startsWith("data:image")
  ) {
    const url = block.image_url.url;
    const match = url.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
    if (match) {
      const [, media_type, data] = match;
      try {
        const description = await describeImage(data, media_type);
        log(`[image-proxy] image_url 图片已识别 (${media_type})`);
        return {
          type: "text",
          text: `[以下是截图内容描述]\n${description}\n[图片描述结束]`,
        };
      } catch (err) {
        log(`[image-proxy] image_url 图片识别失败: ${(err as Error).message}`);
        return {
          type: "text",
          text: `[图片识别失败: ${(err as Error).message}]`,
        };
      }
    }
    return block;
  }
  // 格式3: tool_result 里嵌套图片（MCP 工具返回的截图）
  if (block?.type === "tool_result" && Array.isArray(block.content)) {
    const toolContent = block.content as ContentBlock[];
    const processed = await processContent(toolContent);
    return { ...block, content: processed } as ContentBlock;
  }
  // 其他未识别的 image source type
  if (block?.type === "image" && block.source && !block.source.type?.startsWith("base64")) {
    log(`[image-proxy] 未识别的 image source type: ${block.source.type}`);
  }
  return block;
}

async function processContent(
  content: string | ContentBlock[]
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  // 日志：记录所有 block 类型，方便排查
  const blockTypes = content.map((b) => b?.type || "unknown");
  log(`[image-proxy] content blocks: ${JSON.stringify(blockTypes)}`);

  // 并行识别同一层级的所有图片块，map 保持原顺序
  return Promise.all(content.map((block) => describeBlock(block)));
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

// ────────────────────── 单例锁 ──────────────────────

// 锁文件路径：系统临时目录，跨平台无需权限处理
const LOCK_FILE = path.join(os.tmpdir(), "vision-mcp-proxy.lock");

// 检测 PID 对应的进程是否仍在运行（信号 0 不实际发信号，仅探测存活）
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: 进程不存在；EPERM: 存在但无权限。两者都视为"不可达"，允许接管
    return false;
  }
}

// 尝试获取单例锁：保证全局只有一个 vision-mcp 进程启动图片代理，
// 避免多个 MCP 进程互相 kill 对方占用的 8787 端口（会把正在处理请求的代理杀掉）。
// 返回 true 表示拿到锁、应由本进程启动代理；false 表示已有代理在运行，跳过。
function tryAcquireLock(): boolean {
  try {
    // O_EXCL (wx) 原子创建：文件已存在则抛 EEXIST
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // 其他 IO 错误，保守起见不获取锁
      return false;
    }
    // 锁文件已存在：检查持有者是否还活着
    try {
      const holderPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (holderPid && isProcessAlive(holderPid)) {
        return false; // 持有者仍存活，复用已有代理
      }
      // 持有者已退出（崩溃未释放锁）：清理僵尸锁后递归重试
      fs.unlinkSync(LOCK_FILE);
      return tryAcquireLock();
    } catch {
      return false;
    }
  }
}

// 释放锁：仅当锁文件登记的 PID 是本进程时才删除，避免误删他人的锁
function releaseLock(): void {
  try {
    const holderPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    if (holderPid === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    // 忽略：文件可能已被删除
  }
}

// ────────────────────── 启动代理 ──────────────────────

export function startImageProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!UPSTREAM_BASE_URL) {
      log("[image-proxy] 未设置 UPSTREAM_BASE_URL，代理功能不可用（MCP 工具仍可用）");
      resolve();
      return;
    }

    // 单例锁：保证全局只有一个代理进程。拿不到锁说明已有代理在运行，
    // 直接复用，避免多 MCP 进程互相 kill 8787 端口导致正在处理的请求中断。
    if (!tryAcquireLock()) {
      log("[image-proxy] 已有代理进程在运行，跳过启动（复用已有代理，MCP 工具仍可用）");
      resolve();
      return;
    }

    // 进程退出时释放锁，让其他 MCP 进程下次启动时能接管
    const releaseOnExit = (): void => releaseLock();
    process.on("SIGINT", releaseOnExit);
    process.on("SIGTERM", releaseOnExit);
    process.on("beforeExit", releaseOnExit);
    process.on("exit", releaseOnExit);

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

    server.on("error", (err: Error) => {
      const msg = err.message;
      if (msg.includes("EADDRINUSE")) {
        // 端口已被占用。锁机制保证正常情况下只有一个本 MCP 代理在跑，
        // 这里被占用说明是其他程序，或锁在极端情况下漏网。
        // 不再 kill（避免杀掉正在处理请求的代理），直接放弃启动。
        log(`[image-proxy] 端口 ${PROXY_PORT} 已被占用，放弃启动代理（MCP 工具仍可用）`);
      } else {
        log(`[image-proxy] 代理启动失败（MCP 工具仍可用）: ${msg}`);
      }
      releaseLock();
      resolve();
    });

    server.listen(PROXY_PORT, "127.0.0.1", () => {
      log(`[image-proxy] 代理已启动: http://127.0.0.1:${PROXY_PORT} (pid ${process.pid})`);
      log(`[image-proxy] 上游 API: ${UPSTREAM_BASE_URL}`);
      resolve();
    });
  });
}

// ────────────────────── MCP 端：按需拉起独立代理 ──────────────────────

// 独立代理入口脚本（与本文件同目录，编译后为 dist/proxy/standaloneProxy.js）
const STANDALONE_SCRIPT = fileURLToPath(
  new URL("standaloneProxy.js", import.meta.url)
);

// 读取锁文件里登记的代理 PID；不存在/无效返回 null
function readLockHolderPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// MCP 进程调用：确保有一个独立常驻的图片代理在运行。
// - 锁持有者进程存活 → 复用已有代理
// - 否则 detached spawn 一个独立代理进程，与本 MCP 进程生命周期解耦
// 任何一个 Claude Code 会话退出都不影响代理，代理常驻至自身崩溃或被主动 kill。
export function ensureImageProxyRunning(): Promise<void> {
  return new Promise((resolve) => {
    if (!UPSTREAM_BASE_URL) {
      log("[image-proxy] 未设置 UPSTREAM_BASE_URL，代理功能不可用（MCP 工具仍可用）");
      resolve();
      return;
    }

    // 1. 已有独立代理在运行则直接复用
    const holderPid = readLockHolderPid();
    if (holderPid !== null && isProcessAlive(holderPid)) {
      log(`[image-proxy] 独立代理已在运行 (pid ${holderPid})，复用`);
      resolve();
      return;
    }

    // 2. detached spawn 独立代理进程：stdio ignore + unref，独立于父进程生命周期
    try {
      const child = spawn(process.execPath, [STANDALONE_SCRIPT], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      log(`[image-proxy] 已拉起独立代理进程 (pid ${child.pid})`);
    } catch (err) {
      log(`[image-proxy] 拉起独立代理进程失败: ${(err as Error).message}（MCP 工具仍可用）`);
    }

    // 不等待子进程 listen 完成即返回：MCP 工具不依赖代理，代理会在后台就绪
    resolve();
  });
}
