# Vision MCP Server

为 Claude Code 提供图像识别能力的 MCP server，附带 HTTP 图片拦截代理，让纯文本模型（如 GLM）也能接受图片输入。支持任意 OpenAI 兼容的视觉模型（火山方舟豆包、Kimi、智谱 GLM-4V、通义 Qwen-VL、OpenAI GPT-4o 等）。

[English](README.md) | 简体中文

## 功能特性

本项目包含两部分，可独立或组合使用：

### 1. MCP 工具（默认）

支持两种图片来源：

| 工具 | 输入 | 示例 |
|------|------|------|
| `vision_describe_image` | 本地图片文件 | `C:/Users/me/screenshot.png` |
| `vision_describe_image` | 网络图片 URL | `https://example.com/img.png` |

通过视觉模型识别图片，支持本地文件路径与 http(s):// 图片 URL。

### 2. HTTP 图片拦截代理（可选）
- 用户在 Claude Code 中直接 `Ctrl+V` 粘贴图片即可
- 在 Claude Code 和上游 LLM API 之间做代理
- 自动拦截请求中的图片，调视觉模型识别后替换为文字描述
- 让纯文本模型（如 GLM）也能正常处理图片输入，不再 400 报错

## 支持的视觉模型

只要视觉模型提供 OpenAI 兼容的 `/chat/completions` 端点、且支持 `image_url` + base64 图片输入，均可接入。下表给出代表性示例（模型 ID 以各平台官方文档为准）：

| 平台 | 模型示例（`VISION_MODEL`） | `VISION_BASE_URL` | 申请入口 |
|------|----------------------------|-------------------|----------|
| 火山方舟（豆包） | `doubao-seed-2-1-turbo-260628` / `doubao-seed-2-1-pro-260628` / `doubao-seed-evolving` | `https://ark.cn-beijing.volces.com/api/v3` | console.volcengine.com/ark |
| 月之暗面 Kimi | `kimi-k2.6` | `https://api.moonshot.cn/v1` | platform.moonshot.cn |
| 智谱 | `glm-4v-plus` / `glm-4.5v` | `https://open.bigmodel.cn/api/paas/v4` | open.bigmodel.cn |
| 阿里百炼 | `qwen-vl-max` / `qwen2.5-vl-72b-instruct` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | bailian.console.aliyun.com |
| 硅基流动 | `Qwen/Qwen2-VL-72B-Instruct` 等 | `https://api.siliconflow.cn/v1` | siliconflow.cn |
| OpenAI | `gpt-4o` / `gpt-4o-mini` | `https://api.openai.com/v1` | platform.openai.com |

> 注：火山方舟上目前只有豆包系列支持视觉输入，GLM / DeepSeek 在方舟上均为纯文本。若要用 GLM-4V / Qwen-VL 等非豆包视觉模型，请走对应平台或硅基流动。

## 工作原理

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code                                                      │
│   ├─ 调用 MCP 工具 vision_describe_image -> 视觉模型 API          │
│   └─ 发送消息（含图片）-> http://127.0.0.1:8787 (本代理)          │
│                            ↓                                     │
│                  代理拦截图片 -> 调视觉模型识别 -> 替换为文字      │
│                            ↓                                     │
│                  转发纯文本请求 -> 上游 LLM API（如 GLM）         │
└─────────────────────────────────────────────────────────────────┘
```

MCP 工具和代理共享同一进程、同一份视觉模型配置，启动 MCP server 时代理自动起来。

## 前置条件

- Node.js >= 18
- 视觉模型 API Key（见上表，任选一家申请）

## 配置

### 1. 基础配置（启用 MCP 工具）

编辑 `~/.claude.json`，加入 MCP server 配置，默认支持本地文件 / URL 识图。以火山方舟豆包为例：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "你的火山方舟-api-key",
        "VISION_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
        "VISION_MODEL": "doubao-seed-2-1-turbo-260628"
      }
    }
  }
}
```

改用 Kimi 示例：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "sk-你的-kimi-api-key",
        "VISION_BASE_URL": "https://api.moonshot.cn/v1",
        "VISION_MODEL": "kimi-k2.6"
      }
    }
  }
}
```

重启 Claude Code 后，对 Claude 说"识别 C:/xxx.png"，Claude 会自动调用识图工具。

### 2. 高级配置（启用图片代理，可选）

**什么时候需要**：你用 GLM 等纯文本模型，想在 Claude Code 里直接 `Ctrl+V` 粘贴图片（不用先说"识别图片"）。代理会自动拦截图片，调视觉模型识别后转发给上游模型。

| 用法 | 怎么识图 |
|------|----------|
| 只用 MCP 工具（默认） | 对 Claude 说"识别 C:/xxx.png"或网络图片 URL |
| 启用图片代理 | 直接 `Ctrl+V` 粘贴图片到 Claude |

#### 配置步骤

**第 1 步**：编辑 `~/.claude.json`，配置 MCP server（在基础配置基础上加 `UPSTREAM_BASE_URL`）：

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "你的视觉模型-api-key",
        "VISION_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
        "VISION_MODEL": "doubao-seed-2-1-turbo-260628",
        "UPSTREAM_BASE_URL": "https://你的上游-llm-api-地址"
      }
    }
  }
}
```

**第 2 步**：编辑 `~/.claude/settings.json`，配置 Claude Code 走代理：

```json
{
  "env": {
    "UPSTREAM_BASE_URL": "https://你的上游-llm-api-地址",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "你的上游-llm-api-token"
  }
}
```

> 两处 `env` 作用不同：
> - `~/.claude/settings.json` 的 `env`：Claude Code 自身读取（走代理 + 上游认证）
> - `~/.claude.json` 里 `mcpServers.vision-mcp.env`：MCP server 进程读取（视觉模型 key + 上游纯文本模型请求地址）

**第 3 步**：重启 Claude Code，直接 `Ctrl+V` 粘贴图片即可。

#### 环境变量参考

**Claude Code 端**（`~/.claude/settings.json` 的 `env`）：

| 环境变量 | 必填 | 说明 |
|---------|------|------|
| `ANTHROPIC_BASE_URL` | 是 | `http://127.0.0.1:8787`，代理监听端口从该 URL 解析 |
| `ANTHROPIC_AUTH_TOKEN` | 是 | 上游 LLM API 的认证 token，代理转发时复用 |

**MCP server 端**（`~/.claude.json` 的 `mcpServers.vision-mcp.env`）：

| 环境变量 | 必填 | 默认值 | 说明 |
|---------|------|--------|------|
| `UPSTREAM_BASE_URL` | 是 | - | 上游 LLM API 地址，未设则代理不启动（MCP 工具仍可用） |
| `UPSTREAM_AUTH_TOKEN` | 否 | 取自 `ANTHROPIC_AUTH_TOKEN` | 上游认证 token |
| `VISION_API_KEY` | 是 | - | 视觉模型 API key（MCP 工具与代理共用） |
| `VISION_BASE_URL` | 是 | - | 视觉模型 API 端点（见支持的平台表） |
| `VISION_MODEL` | 是 | - | 视觉模型 ID（见支持的平台表） |
| `IMAGE_DESC_MODE` | 否 | `auto` | 识图模式：`auto` 自动判断设计图/原型图/bug 截图；也可设为 `design_rebuild`、`prototype_understanding`、`bug_screenshot`、`general` |
| `IMAGE_DESC_PROMPT` | 否 | 内置自动分类提示词 | 完全覆盖代理识图提示词。设置后不再使用 `IMAGE_DESC_MODE` 内置模板 |
| `ALLOW_PRIVATE_NETWORK_IMAGES` | 否 | - | 设为 `1` 或 `true` 允许访问内网图片 URL（默认拒绝，防 SSRF） |


## 使用示例

### 用 MCP 工具识图

默认模式为 **`auto` 自动分类解析**：会先判断图片是设计图/页面截图、原型图/线框图、bug/异常截图还是普通图片，然后输出适合纯文本大模型使用的结构化结果。你也可以在对话里指定其他指令，例如"提取图片中的所有文字"、"分析图表数据"、"描述 UI 界面布局"。

对 Claude 说：

```
识别这张图：C:/Users/me/screenshot.png
```
```
描述一下这张网络图片：https://example.com/chart.png
```
```
按设计图还原规格解析：C:/Users/me/design.png
```
```
分析这个测试截图里的可见问题：C:/Users/me/bug.png
```

Claude 会自动调用 `vision_describe_image` 工具。

### 用代理粘贴图片（配置代理后）

在 Claude Code 输入框里直接 `Ctrl+V` 粘贴图片，再输入问题回车：

```
[粘贴图片] 这张图里有什么？
```

代理自动识别图片类型，把设计图还原规格、原型图结构说明或 bug 截图分析结果和你的问题一起发给上游模型。用户不写"还原/原型/bug"等关键词时，也会由视觉模型先自动分类。

## 工具参数

### `vision_describe_image`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `image` | string | 是 | - | 本地文件路径或 http(s):// 图片 URL |
| `prompt` | string | 否 | "请详细描述这张图片的内容。" | 识图指令，最长 4000 字符 |
| `mode` | string | 否 | `auto` | `auto`、`design_rebuild`、`prototype_understanding`、`bug_screenshot`、`general` |

## 限制

- 图片大小上限 20MB（URL 下载与本地文件读取均适用）
- 请求超时 60s（视觉模型 API）、30s（图片下载）
- 输出文本超过 25000 字符会截断
- 支持格式：JPEG / JPG / PNG / GIF / WebP / BMP

## 故障排查

| 错误 | 解决方案 |
|------|----------|
| `VISION_API_KEY 环境变量未设置` | 检查 MCP 配置的 `env.VISION_API_KEY` |
| `视觉模型 API 鉴权失败 (401)` | API key 错误或失效 |
| `视觉模型 API 模型不存在 (404)` | 模型名错误（检查 `VISION_MODEL` 是否与 `VISION_BASE_URL` 对应平台匹配） |
| `视觉模型 API 限流 (429)` | 请求过于频繁，稍后重试 |
| `无法访问本地文件` | 路径错误或无权限 |
| `下载图片失败` | URL 无法访问或超时 |
| `listen EADDRINUSE 127.0.0.1:8787` | 端口被占用，改 `ANTHROPIC_BASE_URL` 里的端口或关掉占用进程 |
| 代理启动失败但 MCP 工具可用 | 不影响 MCP 工具功能，仅代理不可用 |
| 改了代理代码不生效 | 代理是独立常驻进程；`npm run build` 后重开 Claude Code 会话会自动停旧拉新，无需手动 kill |

## 开发

```bash
npm run dev     # 开发模式（tsx watch，热重载）
npm run build   # 编译 TypeScript -> dist/
npm run clean   # 清理构建产物
```

## 贡献

欢迎提 issue 和 PR。支持任意 OpenAI 兼容的视觉模型，架构上已预留扩展点。

## License

[MIT](LICENSE)
