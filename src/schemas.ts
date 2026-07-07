import { z } from "zod";
import { DEFAULT_PROMPT } from "./constants.js";

export const DescribeImageInputSchema = z.object({
  image: z.string()
    .min(1, "image is required")
    .describe("图片路径或 URL。支持本地文件路径（如 C:/Users/user/screenshot.png 或 /tmp/img.jpg）或 http(s):// 开头的图片 URL"),
  prompt: z.string()
    .min(1)
    .max(4000)
    .default(DEFAULT_PROMPT)
    .describe("询问图片的问题或识图指令，例如 '描述图片内容'、'图片中有哪些文字'、'这是什么图表'、'提取图片中的所有文字'"),
  max_tokens: z.number()
    .int()
    .min(1)
    .max(8192)
    .default(2048)
    .describe("返回描述的最大 token 数，1-8192 之间，默认 2048"),
}).strict();

export type DescribeImageInput = z.infer<typeof DescribeImageInputSchema>;
