import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DescribeImageInputSchema } from "../schemas.js";
import { DEFAULT_MODEL, CHARACTER_LIMIT } from "../constants.js";
import { loadImageAsDataUrl } from "../services/image.js";
import { callMoonshot, handleMoonshotError } from "../services/moonshot.js";
import type { DescribeImageInput } from "../schemas.js";
import type { MoonshotContent, MoonshotMessage } from "../types.js";

export function registerDescribeImageTool(
  server: McpServer,
  getApiKey: () => string
): void {
  server.registerTool(
    "kimi_describe_image",
    {
      title: "Kimi 识图",
      description: `使用 Moonshot Kimi 视觉模型 (kimi-k2.6) 识别图片并返回文本描述。

支持输入本地图片路径或 http(s):// 图片 URL。MCP 内部会自动将图片转换为 base64 后调用 Moonshot API（Moonshot 不支持直接传 URL）。

Args:
  - image (string, 必填): 图片路径或 URL。
    - 本地路径示例: "C:/Users/user/screenshot.png" 或 "/tmp/img.jpg"
    - URL 示例: "https://example.com/img.png"
  - prompt (string, 可选): 询问图片的问题或识图指令，默认 "请详细描述这张图片的内容。"。最长 4000 字符
  - max_tokens (number, 可选): 返回描述的最大 token 数，1-8192，默认 2048

Returns:
  文本内容，包含图片描述和 token 使用情况元信息。

Examples:
  - 描述本地截图: image="C:/Users/user/screenshot.png"
  - 描述网络图片: image="https://example.com/chart.png", prompt="图表中显示的数据是什么"
  - 提取文字 (OCR): image="C:/Users/user/document.jpg", prompt="请提取图片中的所有文字"
  - 识别物体: image="C:/Users/user/photo.jpg", prompt="图片里有哪些物体"

Error Handling:
  - "无法访问本地文件": 文件路径错误或无权限
  - "下载图片失败": URL 无法访问或超时
  - "Moonshot API 鉴权失败 (401)": API key 错误
  - "Moonshot API 限流 (429)": 请求过于频繁，请稍后重试`,
      inputSchema: DescribeImageInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: DescribeImageInput) => {
      const apiKey = getApiKey();

      // 1. 加载图片为 data URL
      let imageResult;
      try {
        imageResult = await loadImageAsDataUrl(params.image);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: 加载图片失败 - ${(err as Error).message}`,
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
