import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DescribeClipboardInputSchema } from "../schemas.js";
import { DEFAULT_MODEL, CHARACTER_LIMIT } from "../constants.js";
import { readClipboardImage } from "../services/clipboard.js";
import { callMoonshot, handleMoonshotError } from "../services/moonshot.js";
import type { DescribeClipboardInput } from "../schemas.js";
import type { MoonshotContent, MoonshotMessage } from "../types.js";

export function registerDescribeClipboardTool(
  server: McpServer,
  getApiKey: () => string
): void {
  server.registerTool(
    "kimi_describe_clipboard",
    {
      title: "Kimi 识别剪贴板图片",
      description: `使用 Moonshot Kimi 视觉模型 (kimi-k2.6) 识别剪贴板中的图片并返回文本描述。

直接从系统剪贴板读取图片，无需提供文件路径或 URL。
跨平台支持: Windows (PowerShell)、macOS (pngpaste/osascript)、Linux (xclip/xsel)。

Args:
  - prompt (string, 可选): 询问图片的问题或识图指令，默认 "请详细描述这张图片的内容。"。最长 4000 字符
  - max_tokens (number, 可选): 返回描述的最大 token 数，1-8192，默认 2048

Returns:
  文本内容，包含图片描述和 token 使用情况元信息。

Usage:
  1. 用户先复制一张图片到剪贴板 (Ctrl+C)
  2. 调用此工具即可自动从剪贴板读取并识别

Examples:
  - 描述剪贴板截图: (无参数，使用默认 prompt)
  - 提取剪贴板图片中的文字: prompt="请提取图片中的所有文字"
  - 识别剪贴板中的图表: prompt="图表中显示的数据是什么"

Error Handling:
  - "剪贴板中没有图片": 请先复制一张图片到剪贴板
  - "不支持的平台": 当前操作系统不支持
  - "Moonshot API 鉴权失败 (401)": API key 错误
  - "Moonshot API 限流 (429)": 请求过于频繁，请稍后重试`,
      inputSchema: DescribeClipboardInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: DescribeClipboardInput) => {
      const apiKey = getApiKey();

      // 1. 从剪贴板读取图片
      let imageResult;
      try {
        imageResult = await readClipboardImage();
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: 读取剪贴板图片失败 - ${(err as Error).message}`,
            },
          ],
        };
      }

      // 2. 构造 Moonshot 请求
      const content: MoonshotContent[] = [
        { type: "image_url", image_url: { url: imageResult.dataUrl } },
        { type: "text", text: params.prompt },
      ];
      const messages: MoonshotMessage[] = [{ role: "user", content }];

      // 3. 调用 Moonshot API
      let response;
      try {
        response = await callMoonshot({
          apiKey,
          model: DEFAULT_MODEL,
          messages,
          maxTokens: params.max_tokens,
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: handleMoonshotError(err) }],
        };
      }

      // 4. 提取描述
      const description = response.choices?.[0]?.message?.content ?? "";
      if (!description) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Moonshot API 返回空内容。完整响应: ${JSON.stringify(response)}`,
            },
          ],
        };
      }

      // 5. 构造输出
      const meta = [
        `模型: ${response.model}`,
        `图片大小: ${(imageResult.sizeBytes / 1024).toFixed(2)} KB (${imageResult.mimeType})`,
        `Token 使用: ${response.usage?.total_tokens ?? "未知"} (prompt: ${response.usage?.prompt_tokens ?? "?"}, completion: ${response.usage?.completion_tokens ?? "?"})`,
      ].join("\n");

      let text = `${description}\n\n---\n${meta}`;
      if (text.length > CHARACTER_LIMIT) {
        text = text.slice(0, CHARACTER_LIMIT) + `\n\n[已截断，原文长度 ${text.length} 字符]`;
      }

      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
