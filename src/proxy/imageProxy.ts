import http from "http";
import https from "https";
import { URL, fileURLToPath } from "url";
import zlib from "zlib";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import crypto from "crypto";
import { callVision } from "../services/vision.js";
import { DEFAULT_MAX_TOKENS } from "../constants.js";
import {
  DEFAULT_IMAGE_DESC_MODE,
  buildImageDescriptionPrompt,
} from "../prompts.js";

// ────────────────────── 日志 ──────────────────────

// 日志文件路径：优先用环境变量，否则放项目内 logs/ 目录。
// 用 import.meta.url 定位 dist/proxy/ → 反推项目根：独立代理进程是 detached
// spawn 的，cwd 不可靠（可能继承自任意 Claude Code 会话），只能用脚本自身位置定位。
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const LOG_FILE =
  process.env.VISION_MCP_LOG_FILE ||
  path.join(PROJECT_ROOT, "logs", "vision-mcp-proxy.log");
const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB，超过后清空旧日志

// 确保日志目录存在（环境变量覆盖到自定义路径时同样需要）。同步创建一次即可，
// 失败也不影响代理功能——后续 appendFile 会静默失败，请求转发不受影响。
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  // 目录已存在或无权限，忽略
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function log(msg: string): void {
  const line = `[${nowLocal()}] ${msg}\n`;
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
const IMAGE_DESC_PROMPT = process.env.IMAGE_DESC_PROMPT?.trim();

// 复用到上游模型的连接，减少慢流式响应场景下频繁建连的额外开销。
const upstreamHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const upstreamHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
let nextRequestId = 1;

function requestLabel(requestId: number): string {
  return `[req#${requestId}]`;
}

// ────────────────────── 图片识别 ──────────────────────

// ────────────────────── 图片识别缓存 ──────────────────────

// Claude Code 每次请求都带完整对话历史，历史里的图片会被反复识别（每张 30-60s）。
// 用 base64 的 sha256 做 key 缓存识别结果，同一张图只识别一次。
// LRU 淘汰：Map 按插入顺序，命中时删除重插移到末尾，超限时删最早的。
const IMAGE_CACHE_MAX = 100;
const imageCache = new Map<string, string>();

interface PendingImageDescription {
  promise?: Promise<string>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

// 同一张图片可能同时出现在多个并发请求或历史消息里。复用进行中的识别，
// 只有所有等待者都取消时才中止底层 视觉模型 请求，避免误伤其他请求。
const pendingImageDescriptions = new Map<string, PendingImageDescription>();

function hashImage(base64Data: string, prompt: string): string {
  return crypto
    .createHash("sha256")
    .update(base64Data)
    .update("\n---prompt---\n")
    .update(prompt)
    .digest("hex")
    .slice(0, 32);
}

function getCachedDescription(base64Data: string, prompt: string): string | null {
  const key = hashImage(base64Data, prompt);
  const desc = imageCache.get(key);
  if (desc) {
    imageCache.delete(key);
    imageCache.set(key, desc); // 移到末尾，标记为最近使用
    return desc;
  }
  return null;
}

function setCachedDescription(base64Data: string, prompt: string, description: string): void {
  const key = hashImage(base64Data, prompt);
  imageCache.set(key, description);
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey) imageCache.delete(oldestKey);
  }
}

function isCanceledError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "CanceledError" ||
    err.message === "canceled" ||
    err.message.includes("请求已取消")
  );
}

async function waitForPendingImage(
  task: PendingImageDescription,
  signal?: AbortSignal
): Promise<string> {
  task.waiters++;
  let removeAbortListener = (): void => {};

  try {
    if (!signal) {
      return await task.promise!;
    }
    if (signal.aborted) {
      throw new Error("请求已取消");
    }

    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => reject(new Error("请求已取消"));
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      task.promise!.then(resolve, reject);
    });
  } finally {
    removeAbortListener();
    task.waiters--;
    if (task.waiters === 0 && !task.settled) {
      task.controller.abort();
    }
  }
}

async function describeImage(
  base64Data: string,
  mimeType: string,
  signal?: AbortSignal,
  userPrompt?: string,
  requestId?: number
): Promise<string> {
  if (signal?.aborted) {
    throw new Error("请求已取消");
  }

  const effectivePrompt =
    IMAGE_DESC_PROMPT || buildImageDescriptionPrompt(DEFAULT_IMAGE_DESC_MODE, userPrompt);

  // 成功缓存命中：历史消息里反复出现的同一张图不重复调 视觉模型
  const cached = getCachedDescription(base64Data, effectivePrompt);
  if (cached) {
    log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片命中缓存，跳过识别`);
    return cached;
  }

  const dataUrl = `data:${mimeType};base64,${base64Data}`;
  const apiKey = process.env.VISION_API_KEY || "";
  if (!apiKey) {
    throw new Error("VISION_API_KEY 未设置");
  }

  const key = hashImage(base64Data, effectivePrompt);
  const pending = pendingImageDescriptions.get(key);
  if (pending) {
    log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片识别进行中，复用同一个请求`);
    return waitForPendingImage(pending, signal);
  }

  const task: PendingImageDescription = {
    controller: new AbortController(),
    waiters: 0,
    settled: false,
  };

  task.promise = (async (): Promise<string> => {
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await callVision({
            apiKey,
            messages: [
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: dataUrl } },
                  { type: "text", text: effectivePrompt },
                ],
              },
            ],
            maxTokens: DEFAULT_MAX_TOKENS,
            signal: task.controller.signal,
          });

          const description = response.choices?.[0]?.message?.content || "";
          if (!description) {
            throw new Error("视觉模型 API 返回空内容");
          }
          setCachedDescription(base64Data, effectivePrompt, description);
          return description;
        } catch (err) {
          lastError = err;
          if (isCanceledError(err) || attempt === 2) {
            throw err;
          }
          log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片识别失败，准备重试 1 次: ${(err as Error).message}`);
        }
      }
      throw lastError;
    } finally {
      task.settled = true;
      pendingImageDescriptions.delete(key);
    }
  })();

  pendingImageDescriptions.set(key, task);
  return waitForPendingImage(task, signal);
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

type ImageProcessMode = "full" | "historical_placeholder";

const IMAGE_MARKER_RE =
  /"type"\s*:\s*"(image|image_url|tool_result)"|"source"\s*:\s*\{\s*"type"\s*:\s*"base64"|data:image\/[a-z+.-]+;base64,/i;

function mayContainImagePayload(rawBody: string): boolean {
  // 大多数消息无图，先用轻量文本探测跳过 JSON.parse 和深度扫描。
  return IMAGE_MARKER_RE.test(rawBody);
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content as ContentBlock[]) {
    if (block?.type === "image" || block?.type === "image_url") {
      return true;
    }
    if (block?.type === "tool_result" && contentHasImage(block.content)) {
      return true;
    }
  }
  return false;
}

function collectForwardedImageTexts(content: unknown, result: string[]): void {
  if (!Array.isArray(content)) return;
  for (const block of content as ContentBlock[]) {
    if (
      block?.type === "text" &&
      typeof block.text === "string" &&
      (
        block.text.includes("[以下是用户粘贴的图片内容描述]") ||
        block.text.includes("[以下是截图内容描述]") ||
        block.text.includes("[图片识别失败:")
      )
    ) {
      result.push(block.text);
    }
    if (block?.type === "tool_result") {
      collectForwardedImageTexts(block.content, result);
    }
  }
}

function logForwardedImageTexts(messages: unknown, requestId: number): void {
  if (!Array.isArray(messages)) return;

  const forwardedTexts: string[] = [];
  for (const message of messages) {
    if (message && typeof message === "object" && "content" in message) {
      collectForwardedImageTexts((message as Message).content, forwardedTexts);
    }
  }

  forwardedTexts.forEach((text, index) => {
    log(`${requestLabel(requestId)} [image-proxy] 转发到上游 /v1/messages 的图片内容 #${index + 1} (${text.length} chars):\n${text}`);
  });
}

function collectSiblingText(content: ContentBlock[]): string | undefined {
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2000)
    .trim();
  return text || undefined;
}

function previewText(text: string, maxChars = 160): string {
  return text.replace(/\s+/g, " ").slice(0, maxChars);
}

// 处理单个 content block：图片类型识别后替换为文字，其余原样返回。
// 同层数组的多个图片块由调用方 Promise.all 并行触发，这里只负责单块转换。
async function describeBlock(
  block: ContentBlock,
  signal?: AbortSignal,
  userPrompt?: string,
  requestId?: number,
  mode: ImageProcessMode = "full"
): Promise<ContentBlock> {
  // 格式1: Anthropic 标准 {"type":"image","source":{"type":"base64",...}}
  if (block?.type === "image" && block.source?.type === "base64") {
    const { media_type, data } = block.source as { media_type: string; data: string };
    if (mode === "historical_placeholder") {
      return {
        type: "text",
        text: `[历史图片已省略: ${media_type}, ${Math.round((data.length * 0.75) / 1024)} KB]`,
      };
    }
    try {
      const description = await describeImage(data, media_type, signal, userPrompt, requestId);
      log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片已识别 (${media_type}, ${Math.round((data.length * 0.75) / 1024)} KB)`);
      return {
        type: "text",
        text: `[以下是用户粘贴的图片内容描述]\n${description}\n[图片描述结束]`,
      };
    } catch (err) {
      log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片识别失败: ${(err as Error).message}`);
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
      if (mode === "historical_placeholder") {
        return {
          type: "text",
          text: `[历史图片已省略: ${media_type}, ${Math.round((data.length * 0.75) / 1024)} KB]`,
        };
      }
      try {
        const description = await describeImage(data, media_type, signal, userPrompt, requestId);
        log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] image_url 图片已识别 (${media_type})`);
        return {
          type: "text",
          text: `[以下是截图内容描述]\n${description}\n[图片描述结束]`,
        };
      } catch (err) {
        log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] image_url 图片识别失败: ${(err as Error).message}`);
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
    const processed = await processContent(toolContent, signal, requestId, mode);
    return { ...block, content: processed } as ContentBlock;
  }
  // 其他未识别的 image source type
  if (mode === "historical_placeholder" && block?.type === "image") {
    return {
      type: "text",
      text: "[历史图片已省略: unsupported image source]",
    };
  }
  if (block?.type === "image" && block.source && !block.source.type?.startsWith("base64")) {
    log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 未识别的 image source type: ${block.source.type}`);
  }
  return block;
}

async function processContent(
  content: string | ContentBlock[],
  signal?: AbortSignal,
  requestId?: number,
  mode: ImageProcessMode = "full"
): Promise<string | ContentBlock[]> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;

  // 日志：记录所有 block 类型，方便排查
  const blockTypes = content.map((b) => b?.type || "unknown");
  log(`${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] content blocks: ${JSON.stringify(blockTypes)}`);

  // 并行识别同一层级的所有图片块，map 保持原顺序
  const siblingText = collectSiblingText(content);
  if (
    mode === "full" &&
    siblingText &&
    content.some((block) => block?.type === "image" || block?.type === "image_url")
  ) {
    log(
      `${requestId ? `${requestLabel(requestId)} ` : ""}[image-proxy] 图片同层文本将作为识图任务上下文 (${siblingText.length} chars): ${previewText(siblingText)}`
    );
  }
  return Promise.all(content.map((block) => describeBlock(block, signal, siblingText, requestId, mode)));
}

async function processMessages(
  messages: Message[],
  signal?: AbortSignal,
  requestId?: number
): Promise<Message[]> {
  if (!Array.isArray(messages)) return messages;
  let latestImageMessageIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (contentHasImage(messages[i]?.content)) {
      latestImageMessageIndex = i;
    }
  }
  if (requestId && latestImageMessageIndex >= 0) {
    log(`${requestLabel(requestId)} [image-proxy] 最新含图消息索引: ${latestImageMessageIndex}，更早历史图片将使用短占位`);
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (signal?.aborted) throw new Error("请求已取消");
    if (message && typeof message === "object" && message.content !== undefined) {
      const mode: ImageProcessMode =
        latestImageMessageIndex >= 0 && i < latestImageMessageIndex
          ? "historical_placeholder"
          : "full";
      message.content = await processContent(message.content, signal, requestId, mode) as string | ContentBlock[];
    }
  }
  return messages;
}

// ────────────────────── 转发请求 ──────────────────────

interface ForwardMeta {
  requestId: number; // 本代理分配的请求 ID，用于并发日志关联
  reqStart: number; // 请求进入代理的时间戳（毫秒）
  hasImage: boolean; // 是否含图片（决定是否走过识别流程）
  origSizeKB: string; // 原始请求体大小（KB），用于观察对话体积
}

function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string | null,
  meta: ForwardMeta | null,
  signal?: AbortSignal
): void {
  const baseUrl = new URL(UPSTREAM_BASE_URL);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const fullPath = basePath + (req.url || "");
  const isHttps = baseUrl.protocol === "https:";
  const lib = isHttps ? https : http;
  const upstreamUrl = new URL(fullPath, baseUrl.origin).toString();
  const pathOnly = (req.url || "").split("?")[0];
  if (meta) {
    const elapsed = Date.now() - meta.reqStart;
    log(`${requestLabel(meta.requestId)} [阶段] 转发开始 ${req.method} ${pathOnly} -> ${upstreamUrl} body=${meta.origSizeKB}KB ${meta.hasImage ? "有图" : "无图"} elapsed=${elapsed}ms`);
  }

  const headers = { ...req.headers } as Record<string, string>;
  delete headers["host"];
  headers["host"] = baseUrl.host;
  if (UPSTREAM_AUTH_TOKEN) {
    headers["authorization"] = `Bearer ${UPSTREAM_AUTH_TOKEN}`;
    headers["x-api-key"] = UPSTREAM_AUTH_TOKEN;
  }

  if (body !== null) {
    delete headers["content-length"];
    // body 已被解压/修改，必须删除原压缩标记和逐跳头，否则上游会尝试解压明文导致失败
    delete headers["content-encoding"];
    delete headers["transfer-encoding"];
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  const options: https.RequestOptions = {
    method: req.method,
    hostname: baseUrl.hostname,
    port: baseUrl.port || (isHttps ? 443 : 80),
    path: fullPath,
    headers,
    agent: isHttps ? upstreamHttpsAgent : upstreamHttpAgent,
    signal,
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    const status = proxyRes.statusCode || 502;
    if (meta) {
      const elapsed = Date.now() - meta.reqStart;
      log(
        `${requestLabel(meta.requestId)} [阶段] 上游响应 ${req.method} ${pathOnly} -> ${upstreamUrl} status=${status} body=${meta.origSizeKB}KB ${meta.hasImage ? "有图" : "无图"} 首包耗时=${elapsed}ms`
      );
    }
    if (res.destroyed) {
      proxyRes.destroy();
      return;
    }
    res.writeHead(status, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (err: Error) => {
    if (signal?.aborted || isCanceledError(err) || err.name === "AbortError") {
      return;
    }
    if (meta) {
      const elapsed = Date.now() - meta.reqStart;
      log(`${requestLabel(meta.requestId)} [image-proxy] 转发失败 ${req.method} ${pathOnly} -> ${upstreamUrl} (耗时=${elapsed}ms): ${err.message}`);
    } else {
      log(`[image-proxy] 转发失败 ${req.method} ${pathOnly} -> ${upstreamUrl}: ${err.message}`);
    }
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { type: "proxy_error", message: err.message } })
      );
    }
  });

  if (body !== null) {
    proxyReq.end(body);
  } else {
    req.pipe(proxyReq);
    req.on("aborted", () => proxyReq.destroy(new Error("客户端请求已取消")));
    req.on("error", (err) => proxyReq.destroy(err));
  }
}

// ────────────────────── 单例锁 ──────────────────────

// 锁文件路径：系统临时目录，跨平台无需权限处理
const LOCK_FILE = path.join(os.tmpdir(), "vision-mcp-proxy.lock");

interface ProxyLockInfo {
  pid: number;
  scriptMtimeMs?: number;
  createdAt?: string;
}

function getProxyScriptMtimeMs(): number {
  try {
    return fs.statSync(STANDALONE_SCRIPT).mtimeMs;
  } catch {
    return 0;
  }
}

function createLockInfo(): ProxyLockInfo {
  return {
    pid: process.pid,
    scriptMtimeMs: getProxyScriptMtimeMs(),
    createdAt: new Date().toISOString(),
  };
}

function readProxyLockInfo(): ProxyLockInfo | null {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Partial<ProxyLockInfo>;
      return typeof parsed.pid === "number" && parsed.pid > 0
        ? parsed as ProxyLockInfo
        : null;
    }
    const legacyPid = parseInt(raw, 10);
    return Number.isFinite(legacyPid) && legacyPid > 0
      ? { pid: legacyPid }
      : null;
  } catch {
    return null;
  }
}

function removeLockFile(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // 锁文件可能已被其他进程清理。
  }
}

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForProcessExit(pid: number, timeoutMs = 2000): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(100);
  }
  return !isProcessAlive(pid);
}

function stopProxyProcess(pid: number, reason: string): boolean {
  if (pid === process.pid) return false;
  try {
    log(`[image-proxy] 正在停止旧代理 pid ${pid}: ${reason}`);
    process.kill(pid, "SIGTERM");
  } catch {
    return !isProcessAlive(pid);
  }
  if (waitForProcessExit(pid)) {
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !isProcessAlive(pid);
  }
  return waitForProcessExit(pid);
}

function isProxyLockCurrent(lockInfo: ProxyLockInfo): boolean {
  if (lockInfo.scriptMtimeMs === undefined) return false;
  return Math.abs(lockInfo.scriptMtimeMs - getProxyScriptMtimeMs()) < 1;
}

// 尝试获取单例锁：保证全局只有一个 vision-mcp 进程启动图片代理，
// 避免多个 MCP 进程互相 kill 对方占用的 8787 端口（会把正在处理请求的代理杀掉）。
// 返回 true 表示拿到锁、应由本进程启动代理；false 表示已有代理在运行，跳过。
function tryAcquireLock(): boolean {
  try {
    // O_EXCL (wx) 原子创建：文件已存在则抛 EEXIST
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, JSON.stringify(createLockInfo()));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // 其他 IO 错误，保守起见不获取锁
      return false;
    }
    // 锁文件已存在：检查持有者是否还活着
    try {
      const lockInfo = readProxyLockInfo();
      if (!lockInfo) {
        removeLockFile();
        return tryAcquireLock();
      }
      if (isProcessAlive(lockInfo.pid)) {
        if (isProxyLockCurrent(lockInfo)) {
          return false; // 持有者仍存活且脚本版本匹配，复用已有代理
        }
        if (!stopProxyProcess(lockInfo.pid, "代理脚本已更新")) {
          return false;
        }
        removeLockFile();
        return tryAcquireLock();
      }
      // 持有者已退出（崩溃未释放锁）：清理僵尸锁后递归重试
      removeLockFile();
      return tryAcquireLock();
    } catch {
      return false;
    }
  }
}

// 释放锁：仅当锁文件登记的 PID 是本进程时才删除，避免误删他人的锁
function releaseLock(): void {
  try {
    const lockInfo = readProxyLockInfo();
    if (lockInfo?.pid === process.pid) {
      removeLockFile();
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
      const requestId = nextRequestId++;
      const reqStart = Date.now();
      // Claude Code 中断/重试时立即取消本轮代理工作，避免旧请求继续占用
      // 视觉模型 调用或上游流式连接。
      const requestController = new AbortController();
      const abortRequest = (): void => {
        if (!res.writableEnded) {
          requestController.abort();
        }
      };
      req.on("aborted", abortRequest);
      res.on("close", abortRequest);

      // /v1/messages 是 Anthropic Claude Messages API 端点，只有这类请求的 body
      // 里才可能带图片，需要读全 body 拦截处理；其它请求（/v1/models、健康检查等）
      // 直接透传，不解析 body 以省开销。用 includes 而非 === 是因为 url 可能带
      // query string 或 UPSTREAM_BASE_URL 的 basePath 前缀。
      const isMessagesEndpoint =
        req.method === "POST" && (req.url || "").includes("/v1/messages");
      const pathOnly = (req.url || "").split("?")[0];
      log(`${requestLabel(requestId)} [阶段] 接收 ${req.method} ${pathOnly}`);

      if (!isMessagesEndpoint) {
        forwardRequest(req, res, null, {
          requestId,
          reqStart,
          hasImage: false,
          origSizeKB: "?",
        }, requestController.signal);
        return;
      }

      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", async () => {
        const buffer = Buffer.concat(chunks);
        const contentEncoding = (req.headers["content-encoding"] || "").toLowerCase();
        log(
          `${requestLabel(requestId)} [阶段] body读取完成 ${req.method} ${pathOnly} size=${(buffer.length / 1024).toFixed(1)}KB encoding=${contentEncoding || "none"} elapsed=${Date.now() - reqStart}ms`
        );

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
          log(
            `${requestLabel(requestId)} [阶段] body解码完成 ${req.method} ${pathOnly} rawSize=${(Buffer.byteLength(rawBody) / 1024).toFixed(1)}KB elapsed=${Date.now() - reqStart}ms`
          );
        } catch (err) {
          log(`${requestLabel(requestId)} [image-proxy] 请求体解压失败: ${(err as Error).message}`);
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
          const origSizeKB = (Buffer.byteLength(rawBody) / 1024).toFixed(1);
          if (!mayContainImagePayload(rawBody)) {
            log(`${requestLabel(requestId)} [阶段] 无图快速转发 ${req.method} ${pathOnly} elapsed=${Date.now() - reqStart}ms`);
            forwardRequest(req, res, rawBody, {
              requestId,
              reqStart,
              hasImage: false,
              origSizeKB,
            }, requestController.signal);
            return;
          }

          const requestData = JSON.parse(rawBody);
          log(`${requestLabel(requestId)} [阶段] JSON解析完成 ${req.method} ${pathOnly} elapsed=${Date.now() - reqStart}ms`);
          let hasImage = false;
          if (Array.isArray(requestData.messages)) {
            for (const msg of requestData.messages) {
              hasImage = contentHasImage(msg.content);
              if (hasImage) break;
            }
          }

          if (hasImage) {
            log(`${requestLabel(requestId)} [image-proxy] 检测到图片，开始识别...`);
            requestData.messages = await processMessages(requestData.messages, requestController.signal, requestId);
            log(`${requestLabel(requestId)} [阶段] 图片处理完成 ${req.method} ${pathOnly} elapsed=${Date.now() - reqStart}ms`);
            logForwardedImageTexts(requestData.messages, requestId);
            const newBody = JSON.stringify(requestData);
            forwardRequest(req, res, newBody, {
              requestId,
              reqStart,
              hasImage: true,
              origSizeKB,
            }, requestController.signal);
          } else {
            forwardRequest(req, res, rawBody, {
              requestId,
              reqStart,
              hasImage: false,
              origSizeKB,
            }, requestController.signal);
          }
        } catch (err) {
          if (requestController.signal.aborted || isCanceledError(err)) {
            return;
          }
          log(`${requestLabel(requestId)} [image-proxy] 处理失败: ${(err as Error).message}`);
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
        log(`${requestLabel(requestId)} [image-proxy] 请求错误: ${err.message}`);
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
      log(`[image-proxy] 识图模式: ${IMAGE_DESC_PROMPT ? "custom IMAGE_DESC_PROMPT" : DEFAULT_IMAGE_DESC_MODE}, max_tokens=${DEFAULT_MAX_TOKENS}`);
      resolve();
    });
  });
}

// ────────────────────── MCP 端：按需拉起独立代理 ──────────────────────

// 独立代理入口脚本（与本文件同目录，编译后为 dist/proxy/standaloneProxy.js）
const STANDALONE_SCRIPT = fileURLToPath(
  new URL("standaloneProxy.js", import.meta.url)
);

/**
 * MCP 启动/重连时的代理协调器。
 *
 * 代理本身以 detached 子进程常驻，和当前 MCP 会话解耦：
 * 全局只保留一个 HTTP 图片代理，避免多个 Claude Code 会话抢占同一端口。
 * 关闭某个 Claude Code 会话不会停止代理，后续会话可以继续复用同一个端口。
 *
 * 锁文件用于记录当前代理 PID 和 standaloneProxy.js 的构建时间戳。
 * 当 npm run build 更新了 dist/proxy/standaloneProxy.js 后，下一次 MCP 重连会
 * 发现锁里的 scriptMtimeMs 已过期，自动停止旧代理、删除旧锁并拉起新代理。
 *
 * 旧版锁文件只包含 PID，没有脚本版本信息；这类锁会被视为版本未知，
 * 在 MCP 重连时允许自动接管，避免开发时手动 taskkill 和删除 lock。
 */
export function ensureImageProxyRunning(): Promise<void> {
  return new Promise((resolve) => {
    if (!UPSTREAM_BASE_URL) {
      log("[image-proxy] 未设置 UPSTREAM_BASE_URL，代理功能不可用（MCP 工具仍可用）");
      resolve();
      return;
    }

    // 1. 处理已有锁：复用仍然有效的代理，或接管过期/僵尸代理。
    const lockInfo = readProxyLockInfo();
    if (lockInfo !== null && isProcessAlive(lockInfo.pid)) {
      if (isProxyLockCurrent(lockInfo)) {
        log(`[image-proxy] 独立代理已在运行 (pid ${lockInfo.pid})，复用`);
        resolve();
        return;
      }
      if (stopProxyProcess(lockInfo.pid, "MCP 重连时检测到代理脚本已更新")) {
        removeLockFile();
      } else {
        log(`[image-proxy] 旧代理仍在运行 (pid ${lockInfo.pid})，放弃自动重启（MCP 工具仍可用）`);
        resolve();
        return;
      }
    } else if (lockInfo !== null) {
      removeLockFile();
    }

    // 2. 无可复用代理时，拉起新的 detached 代理进程。
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
