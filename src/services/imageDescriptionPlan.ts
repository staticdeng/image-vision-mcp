/**
 * 图片描述请求计划。
 *
 * 这里只负责根据识图 mode 选择初始 max_tokens，并在调用方发现输出不足时
 * 提供升档重试策略。它不会额外发起图片类型预判请求，避免普通图片识别变慢。
 */
import { DEFAULT_MAX_TOKENS } from "../constants.js";
import {
  buildImageDescriptionPrompt,
  type ImageDescMode,
} from "../prompts.js";
import type { VisionChatResponse } from "../types.js";

const TOKEN_ESCALATION_STEPS = [2048, 4096, 8192, 16384, 32768] as const;

export interface ImageDescriptionPlan {
  mode: ImageDescMode;
  prompt: string;
  maxTokens: number;
  allowTokenEscalation: boolean;
}

interface BuildImageDescriptionPlanParams {
  mode: ImageDescMode;
  userPrompt?: string;
}

export function maxTokensForImageMode(mode: ImageDescMode): number {
  switch (mode) {
    case "design_rebuild":
      return 8192;
    case "prototype_understanding":
    case "bug_screenshot":
      return 4096;
    case "general":
      return DEFAULT_MAX_TOKENS;
    case "auto":
    default:
      return 4096;
  }
}

export function buildImageDescriptionPlan(
  params: BuildImageDescriptionPlanParams
): ImageDescriptionPlan {
  const requestedMode = params.mode;
  const requestedPrompt = buildImageDescriptionPrompt(requestedMode, params.userPrompt);
  return {
    mode: requestedMode,
    prompt: requestedPrompt,
    maxTokens: maxTokensForImageMode(requestedMode),
    allowTokenEscalation: true,
  };
}

export function shouldRetryWithMoreTokens(
  response: VisionChatResponse,
  description: string
): boolean {
  return response.choices?.[0]?.finish_reason === "length" || !description;
}

export function nextMaxTokens(current: number): number | null {
  for (const step of TOKEN_ESCALATION_STEPS) {
    if (step > current) return step;
  }
  return null;
}
