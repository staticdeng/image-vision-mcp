import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DescribeImageInputSchema } from "../schemas.js";
import { DEFAULT_MODEL, CHARACTER_LIMIT } from "../constants.js";
import { loadImageAsDataUrl } from "../services/image.js";
import { callVision, handleVisionError } from "../services/vision.js";
import { buildImageDescriptionPrompt } from "../prompts.js";
import type { DescribeImageInput } from "../schemas.js";
import type { VisionContent, VisionMessage } from "../types.js";

export function registerDescribeImageTool(
  server: McpServer,
  getApiKey: () => string
): void {
  server.registerTool(
    "vision_describe_image",
    {
      title: "视觉识图",
      description: `使用视觉模型识别图片并返回文本描述。支持任意 OpenAI 兼容的视觉模型（火山方舟豆包、Kimi、智谱 GLM-4V、通义 Qwen-VL、OpenAI GPT-4o 等）。

支持输入本地图片路径或 http(s):// 图片 URL。MCP 内部会自动将图片转换为 base64 后调用视觉模型 API（多数视觉模型不支持直接传 URL）。

Args:
  - image (string, 必填): 图片路径或 URL。
    - 本地路径示例: "C:/Users/user/screenshot.png" 或 "/tmp/img.jpg"
    - URL 示例: "https://example.com/img.png"
  - prompt (string, 可选): 额外识图指令，会附加到当前 mode 的提示词模板后；不传则仅使用模式模板（默认 auto 自动分类）。最长 4000 字符
  - mode (string, 可选): auto / design_rebuild / prototype_understanding / bug_screenshot / general，默认 auto
  - max_tokens (number, 可选): 返回描述的最大 token 数，1-8192，默认由 VISION_MAX_TOKENS 控制，未设置为 2048

Returns:
  文本内容。默认会先自动判断图片类型，再输出适合设计图还原、原型图理解或 bug 截图分析的结构化结果，并附带 token 使用情况元信息。

Examples:
  - 描述本地截图: image="C:/Users/user/screenshot.png"
  - 还原设计图: image="C:/Users/user/design.png", mode="design_rebuild"
  - 理解原型图: image="C:/Users/user/prototype.png", mode="prototype_understanding"
  - 分析测试截图: image="C:/Users/user/bug.png", mode="bug_screenshot"
  - 提取文字 (OCR): image="C:/Users/user/document.jpg", prompt="请提取图片中的所有文字"
  - 普通识图: image="C:/Users/user/photo.jpg", mode="general", prompt="图片里有哪些物体"

Error Handling:
  - "无法访问本地文件": 文件路径错误或无权限
  - "下载图片失败": URL 无法访问或超时
  - "视觉模型 API 鉴权失败 (401)": API key 错误
  - "视觉模型 API 限流 (429)": 请求过于频繁，请稍后重试`,
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

      // 2. 构造视觉模型请求
      const visionPrompt = buildImageDescriptionPrompt(params.mode, params.prompt);
      const content: VisionContent[] = [
        { type: "image_url", image_url: { url: imageResult.dataUrl } },
        { type: "text", text: visionPrompt },
      ];
      const messages: VisionMessage[] = [{ role: "user", content }];

      // 3. 调用视觉模型 API
      let response;
      try {
        response = await callVision({
          apiKey,
          model: DEFAULT_MODEL,
          messages,
          maxTokens: params.max_tokens,
        });
      } catch (err) {
        return {
          content: [{ type: "text", text: handleVisionError(err) }],
        };
      }

      // 4. 提取描述
      const description = response.choices?.[0]?.message?.content ?? "";
      if (!description) {
        return {
          content: [
            {
              type: "text",
              text: `Error: 视觉模型 API 返回空内容。完整响应: ${JSON.stringify(response)}`,
            },
          ],
        };
      }

      // 5. 构造输出
      const meta = [
        `模型: ${response.model}`,
        `识图模式: ${params.mode}`,
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
