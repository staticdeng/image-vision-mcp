# Vision MCP Server

An MCP server that gives Claude Code image-recognition capabilities, bundled with an HTTP image-intercepting proxy that lets text-only models (such as GLM) accept image input. Works with any OpenAI-compatible vision model (Volcengine Doubao, Kimi, Zhipu GLM-4V, Alibaba Qwen-VL, OpenAI GPT-4o, etc.).

English | [简体中文](README.zh-CN.md)

## Features

This project ships two parts that can be used independently or together:

### 1. MCP Tool (default)

Supports two image sources:

| Tool | Input | Example |
|------|-------|---------|
| `vision_describe_image` | Local image file | `C:/Users/me/screenshot.png` |
| `vision_describe_image` | Image URL | `https://example.com/img.png` |

Recognizes images via a vision model. Both local file paths and http(s):// image URLs are supported.

### 2. HTTP Image-Intercepting Proxy (optional)
- Just `Ctrl+V` paste images directly in Claude Code
- Sits between Claude Code and the upstream LLM API
- Automatically intercepts images in requests, calls a vision model to describe them, and replaces them with text
- Lets text-only models (such as GLM) handle image input without 400 errors

## Supported Vision Models

Any vision model that exposes an OpenAI-compatible `/chat/completions` endpoint and supports `image_url` + base64 image input works. The table below lists representative examples (model IDs are subject to each platform's official docs):

| Platform | Example model (`VISION_MODEL`) | `VISION_BASE_URL` | Where to get a key |
|----------|--------------------------------|-------------------|--------------------|
| Volcengine (Doubao) | `doubao-seed-2-1-turbo-260628` / `doubao-seed-2-1-pro-260628` / `doubao-seed-evolving` | `https://ark.cn-beijing.volces.com/api/v3` | console.volcengine.com/ark |
| Moonshot Kimi | `kimi-k2.6` | `https://api.moonshot.cn/v1` | platform.moonshot.cn |
| Zhipu | `glm-4v-plus` / `glm-4.5v` | `https://open.bigmodel.cn/api/paas/v4` | open.bigmodel.cn |
| Alibaba Bailian | `qwen-vl-max` / `qwen2.5-vl-72b-instruct` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | bailian.console.aliyun.com |
| SiliconFlow | `Qwen/Qwen2-VL-72B-Instruct`, etc. | `https://api.siliconflow.cn/v1` | siliconflow.cn |
| OpenAI | `gpt-4o` / `gpt-4o-mini` | `https://api.openai.com/v1` | platform.openai.com |

> Note: On Volcengine Ark, only the Doubao family supports vision input today; GLM and DeepSeek on Ark are text-only. To use non-Doubao vision models such as GLM-4V or Qwen-VL, use their native platform or SiliconFlow.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code                                                      │
│   ├─ Calls MCP tool vision_describe_image -> vision model API    │
│   └─ Sends message (with image) -> http://127.0.0.1:8787 (proxy) │
│                            ↓                                     │
│            Proxy intercepts image -> calls vision model ->       │
│            replaces it with a text description                   │
│                            ↓                                     │
│            Forwards text-only request -> upstream LLM (e.g. GLM) │
└─────────────────────────────────────────────────────────────────┘
```

The MCP tool and the proxy share the same process and the same vision-model config. Starting the MCP server also brings up the proxy automatically.

## Prerequisites

- Node.js >= 18
- A vision-model API key (apply at any platform listed above)

## Configuration

### 1. Basic config (enable the MCP tool)

Edit `~/.claude.json` and add the MCP server config. Local file / URL image recognition works out of the box. Using Volcengine Doubao as an example:

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "your-volcengine-api-key",
        "VISION_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
        "VISION_MODEL": "doubao-seed-2-1-turbo-260628"
      }
    }
  }
}
```

Switching to Kimi:

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "sk-your-kimi-api-key",
        "VISION_BASE_URL": "https://api.moonshot.cn/v1",
        "VISION_MODEL": "kimi-k2.6"
      }
    }
  }
}
```

After restarting Claude Code, tell Claude "describe C:/xxx.png" and it will call the vision tool automatically.

### 2. Advanced config (enable the image proxy, optional)

**When you need it**: you use a text-only model like GLM and want to `Ctrl+V` paste images directly in Claude Code (without first saying "describe this image"). The proxy intercepts the image, calls a vision model, and forwards the description to the upstream model.

| Usage | How to recognize images |
|-------|--------------------------|
| MCP tool only (default) | Tell Claude "describe C:/xxx.png" or an image URL |
| Enable the image proxy | Just `Ctrl+V` paste the image into Claude |

#### Setup steps

**Step 1**: Edit `~/.claude.json` to configure the MCP server (add `UPSTREAM_BASE_URL` on top of the basic config):

```json
{
  "mcpServers": {
    "vision-mcp": {
      "command": "npx",
      "args": ["-y", "image-vision-mcp"],
      "env": {
        "VISION_API_KEY": "your-vision-model-api-key",
        "VISION_BASE_URL": "https://ark.cn-beijing.volces.com/api/v3",
        "VISION_MODEL": "doubao-seed-2-1-turbo-260628",
        "UPSTREAM_BASE_URL": "https://your-upstream-llm-api-endpoint"
      }
    }
  }
}
```

**Step 2**: Edit `~/.claude/settings.json` to route Claude Code through the proxy:

```json
{
  "env": {
    "UPSTREAM_BASE_URL": "https://your-upstream-llm-api-endpoint",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "your-upstream-llm-api-token"
  }
}
```

> The two `env` blocks serve different purposes:
> - `~/.claude/settings.json` `env`: read by Claude Code itself (routing through the proxy + upstream auth)
> - `~/.claude.json` `mcpServers.vision-mcp.env`: read by the MCP server process (vision-model key + upstream text-model request endpoint)

**Step 3**: Restart Claude Code, then `Ctrl+V` paste images directly.

#### Environment variable reference

**Claude Code side** (`~/.claude/settings.json` `env`):

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_BASE_URL` | Yes | `http://127.0.0.1:8787`; the proxy parses its listen port from this URL |
| `ANTHROPIC_AUTH_TOKEN` | Yes | Auth token for the upstream LLM API; reused by the proxy when forwarding |

**MCP server side** (`~/.claude.json` `mcpServers.vision-mcp.env`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPSTREAM_BASE_URL` | Yes | - | Upstream LLM API endpoint. If unset, the proxy does not start (the MCP tool still works) |
| `UPSTREAM_AUTH_TOKEN` | No | Taken from `ANTHROPIC_AUTH_TOKEN` | Upstream auth token |
| `VISION_API_KEY` | Yes | - | Vision-model API key (shared by the MCP tool and the proxy) |
| `VISION_BASE_URL` | Yes | - | Vision-model API endpoint (see the supported-platform table) |
| `VISION_MODEL` | Yes | - | Vision-model ID (see the supported-platform table) |
| `IMAGE_DESC_MODE` | No | `auto` | Image-description mode: `auto` auto-detects design / prototype / bug screenshot; can also be `design_rebuild`, `prototype_understanding`, `bug_screenshot`, `general` |
| `IMAGE_DESC_PROMPT` | No | Built-in auto-classification prompt | Fully overrides the proxy's image-description prompt. When set, the `IMAGE_DESC_MODE` built-in template is not used |
| `ALLOW_PRIVATE_NETWORK_IMAGES` | No | - | Set to `1` or `true` to allow internal/private-network image URLs (denied by default to prevent SSRF) |


## Usage Examples

### Recognize images with the MCP tool

The default mode is **`auto` auto-classification**: it first determines whether the image is a design / page screenshot, a prototype / wireframe, a bug / exception screenshot, or a generic image, then outputs a structured result tailored for text-only LLMs. You can also give other instructions in the conversation, e.g. "extract all text from the image", "analyze the chart data", "describe the UI layout".

Tell Claude:

```
Describe this image: C:/Users/me/screenshot.png
```
```
Describe this web image: https://example.com/chart.png
```
```
Parse this as a design-spec rebuild: C:/Users/me/design.png
```
```
Analyze the visible issues in this test screenshot: C:/Users/me/bug.png
```

Claude will call the `vision_describe_image` tool automatically.

### Paste images through the proxy (after configuring the proxy)

`Ctrl+V` paste an image directly into the Claude Code input box, type your question, and press Enter:

```
[paste image] What's in this image?
```

The proxy auto-detects the image type and sends the design-spec rebuild, prototype structure explanation, or bug-screenshot analysis (along with your question) to the upstream model. Even without keywords like "rebuild / prototype / bug", the vision model classifies the image first.

## Tool Parameters

### `vision_describe_image`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image` | string | Yes | - | Local file path or http(s):// image URL |
| `prompt` | string | No | "Please describe this image in detail." | Image-description instruction, up to 4000 characters |
| `mode` | string | No | `auto` | `auto`, `design_rebuild`, `prototype_understanding`, `bug_screenshot`, `general` |

## Limitations

- Max image size 20MB (applies to both URL download and local file read)
- Request timeout 60s (vision-model API), 30s (image download)
- Output text is truncated beyond 25000 characters
- Supported formats: JPEG / JPG / PNG / GIF / WebP / BMP

## Troubleshooting

| Error | Solution |
|-------|----------|
| `VISION_API_KEY environment variable not set` | Check `env.VISION_API_KEY` in the MCP config |
| `Vision model API auth failed (401)` | API key is wrong or expired |
| `Vision model API model not found (404)` | Wrong model name (check that `VISION_MODEL` matches the platform of `VISION_BASE_URL`) |
| `Vision model API rate limited (429)` | Too many requests; retry later |
| `Cannot access local file` | Path is wrong or no permission |
| `Image download failed` | URL is unreachable or timed out |
| `listen EADDRINUSE 127.0.0.1:8787` | Port is in use; change the port in `ANTHROPIC_BASE_URL` or stop the occupying process |
| Proxy failed to start but the MCP tool works | The MCP tool is unaffected; only the proxy is unavailable |
| Proxy code changes not taking effect | The proxy is a standalone persistent process. Run `npm run build`, then reopen the Claude Code session -- it auto-restarts the proxy. No manual kill needed |

## Development

```bash
npm run dev     # dev mode (tsx watch, hot reload)
npm run build   # compile TypeScript -> dist/
npm run clean   # clean build output
```

## Contributing

Issues and PRs welcome. Any OpenAI-compatible vision model is supported; extension points are already in place.

## License

[MIT](LICENSE)
