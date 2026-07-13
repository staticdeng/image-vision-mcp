export const API_BASE_URL = process.env.VISION_BASE_URL?.replace(/\/+$/, "") || "";
export const DEFAULT_MODEL = process.env.VISION_MODEL || "";
export const CHARACTER_LIMIT = 25000;
export const REQUEST_TIMEOUT_MS = 60000;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30000;
export const IMAGE_MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

export const SUPPORTED_MIME_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
} as const;

export const DEFAULT_PROMPT = "请详细描述这张图片的内容。";
