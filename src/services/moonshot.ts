import axios, { AxiosError } from "axios";
import { API_BASE_URL, DEFAULT_MODEL, REQUEST_TIMEOUT_MS } from "../constants.js";
import type { MoonshotChatResponse, MoonshotMessage } from "../types.js";

export interface CallMoonshotParams {
  apiKey: string;
  model?: string;
  messages: MoonshotMessage[];
  maxTokens?: number;
}

export function handleMoonshotError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data as
        | { error?: { message?: string } }
        | undefined;
      const errMsg = data?.error?.message;
      switch (status) {
        case 401:
          return `Error: Moonshot API 鉴权失败 (401)。请检查 MOONSHOT_API_KEY 是否正确。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 403:
          return `Error: Moonshot API 拒绝访问 (403)。可能是 API key 无权限调用该模型。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 404:
          return `Error: Moonshot API 模型不存在 (404)。请检查模型名是否正确 (当前: ${DEFAULT_MODEL})。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 429:
          return `Error: Moonshot API 限流 (429)。请稍后重试。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        case 500:
        case 502:
        case 503:
          return `Error: Moonshot API 服务端错误 (${status})。请稍后重试。${errMsg ? ` 详情: ${errMsg}` : ""}`;
        default:
          return `Error: Moonshot API 请求失败 (HTTP ${status})。${errMsg ? ` 详情: ${errMsg}` : ""}`;
      }
    }
    if (error.code === "ECONNABORTED") {
      return `Error: Moonshot API 请求超时 (${REQUEST_TIMEOUT_MS}ms)。请稍后重试。`;
    }
    if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED") {
      return `Error: 无法连接 Moonshot API (${error.code})。请检查网络。`;
    }
  }
  return `Error: 调用 Moonshot API 时发生意外错误: ${error instanceof Error ? error.message : String(error)}`;
}

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1000;

export async function callMoonshot(params: CallMoonshotParams): Promise<MoonshotChatResponse> {
  const { apiKey, model = DEFAULT_MODEL, messages, maxTokens = 2048 } = params;
  if (!apiKey) {
    throw new Error("MOONSHOT_API_KEY 未设置");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post<MoonshotChatResponse>(
        `${API_BASE_URL}/chat/completions`,
        {
          model,
          messages,
          max_tokens: maxTokens,
        },
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        }
      );
      return response.data;
    } catch (err) {
      lastError = err;
      // 仅对 429 限流重试，指数退避：1s, 2s
      if (err instanceof AxiosError && err.response?.status === 429 && attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
