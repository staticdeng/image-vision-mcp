import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { IMAGE_MAX_SIZE_BYTES } from "../constants.js";
import { imageBufferToDataUrl, detectMimeTypeFromPath } from "./image.js";
import type { ImageLoadResult } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * 生成临时图片路径
 */
function getTempImagePath(): string {
  const timestamp = Date.now();
  return path.join(os.tmpdir(), `kimi_clipboard_${timestamp}.png`);
}

/**
 * 从临时文件加载图片为 data URL，并清理临时文件
 */
async function loadTempImage(tempPath: string): Promise<ImageLoadResult> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(tempPath);
  } finally {
    // 无论成功与否都尝试清理临时文件
    fs.unlink(tempPath).catch(() => {});
  }

  if (buffer.length > IMAGE_MAX_SIZE_BYTES) {
    throw new Error(
      `剪贴板图片过大: ${(buffer.length / 1024 / 1024).toFixed(2)} MB，最大支持 ${IMAGE_MAX_SIZE_BYTES / 1024 / 1024} MB`
    );
  }

  const mimeType = detectMimeTypeFromPath(tempPath); // .png → image/png
  return {
    dataUrl: imageBufferToDataUrl(buffer, mimeType),
    mimeType,
    sizeBytes: buffer.length,
  };
}

// ────────────────────── Windows ──────────────────────

async function readClipboardWindows(): Promise<ImageLoadResult> {
  const tempPath = getTempImagePath();
  // PowerShell 单引号字符串里所有字符都是字面量（含 \ $ 反引号），单引号本身转义为 ''
  // 这样避免路径含特殊字符时被 PowerShell 解释，比双引号 + 反斜杠转义更安全
  const safePath = tempPath.replace(/'/g, "''");

  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) {
    exit 1
}
$img.Save('${safePath}')
$img.Dispose()
exit 0
`.trim();

  try {
    await execFileAsync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psScript,
    ]);
  } catch (err: any) {
    if (err.code === 1) {
      throw new Error("剪贴板中没有图片");
    }
    throw new Error(`PowerShell 读取剪贴板图片失败: ${err.message}`);
  }

  return loadTempImage(tempPath);
}

// ────────────────────── macOS ──────────────────────

async function readClipboardMac(): Promise<ImageLoadResult> {
  const tempPath = getTempImagePath();

  // 优先尝试 pngpaste（brew install pngpaste）
  try {
    await execFileAsync("pngpaste", [tempPath]);
    return loadTempImage(tempPath);
  } catch (err) {
    // pngpaste 不可用或执行失败（如剪贴板无图片），回退到 osascript
    console.error(`[vision-mcp] pngpaste 不可用，回退到 osascript: ${(err as Error).message}`);
  }

  // 使用 AppleScript 从剪贴板读取 PNG 图片
  const appleScript = `
try
    set theFile to (open for access POSIX file "${tempPath}" with write permission)
    try
        write (the clipboard as «class PNGf») to theFile
    on error
        close access theFile
        error "NoImage"
    end try
    close access theFile
on error errMsg
    if errMsg is "NoImage" then
        error "NoImage"
    else
        error errMsg
    end if
end try
`.trim();

  try {
    await execFileAsync("osascript", ["-e", appleScript]);
  } catch (err: any) {
    const msg = err.message || "";
    if (msg.includes("NoImage") || msg.includes("clipboard")) {
      throw new Error("剪贴板中没有图片");
    }
    throw new Error(`osascript 读取剪贴板图片失败: ${msg}`);
  }

  return loadTempImage(tempPath);
}

// ────────────────────── Linux ──────────────────────

async function readClipboardLinux(): Promise<ImageLoadResult> {
  const tempPath = getTempImagePath();

  // 尝试 xclip
  try {
    const { stdout } = await execFileAsync("xclip", [
      "-selection",
      "clipboard",
      "-t",
      "image/png",
      "-o",
    ], { encoding: "buffer" });

    if (!stdout || stdout.length === 0) {
      throw new Error("剪贴板中没有图片");
    }
    await fs.writeFile(tempPath, stdout);
    return loadTempImage(tempPath);
  } catch (err: any) {
    if (err.message?.includes("剪贴板中没有图片")) {
      throw err;
    }
    // xclip 不可用或执行失败，尝试 xsel
  }

  // 尝试 xsel
  try {
    const { stdout } = await execFileAsync("xsel", [
      "--clipboard",
      "--output",
    ], { encoding: "buffer" });

    if (!stdout || stdout.length === 0) {
      throw new Error("剪贴板中没有图片");
    }
    await fs.writeFile(tempPath, stdout);
    return loadTempImage(tempPath);
  } catch (err: any) {
    if (err.message?.includes("剪贴板中没有图片")) {
      throw err;
    }
    throw new Error(
      "Linux 剪贴板读取失败，请安装 xclip 或 xsel: sudo apt install xclip"
    );
  }
}

// ────────────────────── 统一入口 ──────────────────────

/**
 * 跨平台读取剪贴板图片
 *
 * - Windows: PowerShell System.Windows.Forms.Clipboard
 * - macOS: pngpaste (优先) 或 osascript
 * - Linux: xclip (优先) 或 xsel
 */
export async function readClipboardImage(): Promise<ImageLoadResult> {
  const platform = process.platform;

  switch (platform) {
    case "win32":
      return readClipboardWindows();
    case "darwin":
      return readClipboardMac();
    case "linux":
      return readClipboardLinux();
    default:
      throw new Error(`不支持的平台: ${platform}`);
  }
}

/**
 * 清理上次进程异常退出残留的临时图片文件
 *
 * readClipboardImage 用 finally 清理临时文件，但进程被 SIGKILL 时来不及执行。
 * 启动时调一次，扫掉 os.tmpdir() 里所有 kimi_clipboard_*.png。
 */
export async function cleanupOldTempImages(): Promise<void> {
  const tmpDir = os.tmpdir();
  try {
    const files = await fs.readdir(tmpDir);
    const pattern = /^kimi_clipboard_\d+\.png$/;
    await Promise.all(
      files
        .filter((f) => pattern.test(f))
        .map((f) => fs.unlink(path.join(tmpDir, f)).catch(() => {}))
    );
  } catch {
    // 忽略错误
  }
}
