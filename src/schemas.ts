import { z } from "zod";
import { DEFAULT_MAX_TOKENS, DEFAULT_PROMPT } from "./constants.js";
import { DEFAULT_IMAGE_DESC_MODE, IMAGE_DESC_MODES } from "./prompts.js";

export const DescribeImageInputSchema = z.object({
  image: z.string()
    .min(1, "image is required")
    .describe("图片路径或 URL。支持本地文件路径（如 C:/Users/user/screenshot.png 或 /tmp/img.jpg）或 http(s):// 开头的图片 URL"),
  prompt: z.string()
    .min(1)
    .max(4000)
    .default(DEFAULT_PROMPT)
    .describe("额外识图指令，会附加到当前 mode 的提示词模板后；不传则仅使用模式模板（默认 auto 自动分类）。例如 '提取所有文字'、'重点分析错误提示'、'按设计稿还原细节'"),
  mode: z.enum(IMAGE_DESC_MODES)
    .default(DEFAULT_IMAGE_DESC_MODE)
    .describe("识图模式：auto 自动分类；design_rebuild 还原设计图/页面；prototype_understanding 理解原型图/线框图；bug_screenshot 分析测试/异常截图；general 普通图片描述"),
  max_tokens: z.number()
    .int()
    .min(1)
    .max(8192)
    .default(DEFAULT_MAX_TOKENS)
    .describe("返回描述的最大 token 数，1-8192 之间，默认由 VISION_MAX_TOKENS 控制，未设置为 2048"),
}).strict();

export type DescribeImageInput = z.infer<typeof DescribeImageInputSchema>;
