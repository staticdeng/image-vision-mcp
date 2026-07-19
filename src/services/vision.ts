import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  API_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  REQUEST_TIMEOUT_MS,
} from "../constants.js";
import type { VisionChatResponse, VisionMessage, VisionContent } from "../types.js";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
const LOG_FILE =
  process.env.VISION_MCP_LOG_FILE ||
  path.join(PROJECT_ROOT, "logs", "vision-mcp-proxy.log");
const LOG_MAX_SIZE = 10 * 1024 * 1024;

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
} catch {
  // 日志不可写不影响正常调用。
}

function nowLocal(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function logVision(msg: string): void {
  const line = `[${nowLocal()}] ${msg}\n`;
  console.error(line.trim());
  fs.stat(LOG_FILE, (statErr, stats) => {
    if (statErr || stats.size < LOG_MAX_SIZE) {
      fs.appendFile(LOG_FILE, line, () => {});
    } else {
      fs.writeFile(LOG_FILE, line, () => {});
    }
  });
}

export interface CallVisionParams {
  apiKey: string;
  model?: string;
  messages: VisionMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export function handleVisionError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data as
        | { error?: { message?: string } }
        | undefined;
      const errMsg = data?.error?.message;
      switch (status) {
        case 401:
          return `Error: 视觉模型 API 鉴权失败 (401)。请检查 VISION_API_KEY 是否正确。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 403:
          return `Error: 视觉模型 API 拒绝访问 (403)。可能是 API key 无权限调用该模型。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 404:
          return `Error: 视觉模型 API 模型不存在 (404)。请检查模型名是否正确 (当前: ${DEFAULT_MODEL})。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 429:
          return `Error: 视觉模型 API 限流 (429)。请稍后重试。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 500:
        case 502:
        case 503:
          return `Error: 视觉模型 API 服务端错误 (${status})。请稍后重试。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        default:
          return `Error: 视觉模型 API 请求失败 (HTTP ${status})。${errMsg ? ` 详情: ${errMsg}` : ""}`;
      }
    }
    if (error.code === "ECONNABORTED") {
      return `Error: 视觉模型 API 请求超时 (${REQUEST_TIMEOUT_MS}ms)。请稍后重试。`;
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return `Error: 无法连接视觉模型 API (${error.code})。请检查网络。`;
    }
    if (error.code === "ERR_CANCELED" || error.message === "canceled") {
      return "Error: 视觉模型 API 请求已取消。";
    }
  }
  return `Error: 调用视觉模型 API 时发生意外错误: ${error instanceof Error ? error.message : String(error)}`;
}

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1000;

function summarizeContent(content: string | VisionContent[]): unknown {
  if (typeof content === "string") {
    return { type: "text", chars: content.length, preview: content.slice(0, 120) };
  }
  if (!Array.isArray(content)) return { type: typeof content };

  return content.map((block) => {
    if (block.type === "text") {
      return {
        type: "text",
        chars: block.text.length,
        preview: block.text.slice(0, 120),
      };
    }
    if (block.type === "image_url") {
      const url = block.image_url.url;
      const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.*)$/i);
      if (dataUrlMatch) {
        return {
          type: "image_url",
          mimeType: dataUrlMatch[1],
          sizeKB: ((dataUrlMatch[2].length * 0.75) / 1024).toFixed(1),
        };
      }
      return { type: "image_url", url };
    }
    const fallbackBlock = block as { type?: string };
    return { type: fallbackBlock.type || typeof block };
  });
}

function summarizeVisionResponse(response: VisionChatResponse): unknown {
  return {
    id: response.id,
    model: response.model,
    choices: response.choices?.map((choice) => ({
      index: choice.index,
      finish_reason: choice.finish_reason,
      message_role: choice.message?.role,
      content_chars: extractMessageText(choice.message).length,
      content_preview: extractMessageText(choice.message).slice(0, 160),
      reasoning_chars: choice.message?.reasoning_content?.length ?? 0,
    })) ?? [],
    usage: response.usage,
  };
}

function extractContentText(content: VisionChatResponse["choices"][number]["message"]["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block?.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractMessageText(message: VisionChatResponse["choices"][number]["message"] | undefined): string {
  if (!message) return "";
  return extractContentText(message.content);
}

export function extractVisionText(response: VisionChatResponse): string {
  return extractMessageText(response.choices?.[0]?.message).trim();
}

export function buildEmptyVisionContentError(
  response: VisionChatResponse,
  maxTokens: number
): string {
  const choice = response.choices?.[0];
  const finishReason = choice?.finish_reason || "unknown";
  const reasoningChars = choice?.message?.reasoning_content?.length ?? 0;
  const totalTokens = response.usage?.total_tokens ?? "unknown";
  const completionTokens = response.usage?.completion_tokens ?? "unknown";

  if (finishReason === "length") {
    return (
      `视觉模型 API 返回空内容：响应因 max_tokens=${maxTokens} 截断，` +
      `completion_tokens=${completionTokens}, total_tokens=${totalTokens}。` +
      "如果自动升档后仍发生截断，请改用支持更长输出的视觉模型。"
    );
  }

  if (reasoningChars > 0) {
    return (
      `视觉模型 API 返回空内容：模型只返回了 reasoning_content (${reasoningChars} chars)，` +
      `finish_reason=${finishReason}。请更换支持非推理输出或更长输出的视觉模型。`
    );
  }

  return `视觉模型 API 返回空内容：finish_reason=${finishReason}`;
}

// 重试退避也要响应取消，否则客户端已经中断时还会继续占着任务。
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(new Error("视觉模型 API 请求已取消"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("视觉模型 API 请求已取消"));
      },
      { once: true }
    );
  });
}

export async function callVision(params: CallVisionParams): Promise<VisionChatResponse> {
  const { apiKey, model = DEFAULT_MODEL, messages, maxTokens = DEFAULT_MAX_TOKENS, signal } = params;
  if (!apiKey) {
    throw new Error("VISION_API_KEY 未设置");
  }

  const requestUrl = `${API_BASE_URL}/chat/completions`;
  const requestSummary = {
    model,
    max_tokens: maxTokens,
    messages: messages.map((message) => ({
      role: message.role,
      content: summarizeContent(message.content),
    })),
  };
  logVision(`[Vision] POST ${requestUrl} body=${JSON.stringify(requestSummary)}`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post<VisionChatResponse>(
        requestUrl,
        {
          model,
          messages,
          max_tokens: maxTokens,
        },
        {
          timeout: REQUEST_TIMEOUT_MS,
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );
      logVision(`[Vision] response ${JSON.stringify(summarizeVisionResponse(response.data))}`);
      return response.data;
    } catch (err) {
      lastError = err;
      // 仅对 429 限流重试，指数退避：1s, 2s
      if (err instanceof AxiosError && err.response?.status === 429 && attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay, signal);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
