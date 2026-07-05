import fs from "fs/promises";
import type { Stats } from "fs";
import path from "path";
import { URL } from "url";
import net from "net";
import http from "http";
import https from "https";
import dns from "dns";
import type { LookupAddress } from "dns";
import axios from "axios";
import type { AxiosRequestConfig } from "axios";
import {
  SUPPORTED_MIME_TYPES,
  IMAGE_DOWNLOAD_TIMEOUT_MS,
  IMAGE_MAX_SIZE_BYTES,
} from "../constants.js";
import type { ImageLoadResult } from "../types.js";

export function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

// ────────────────────── SSRF 防护 ──────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal", // GCP 元数据
  "metadata", // 一些云环境的简写
]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local（含 AWS/GCP 元数据）
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true; // 未指定
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  return false;
}

export interface UrlCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 校验图片 URL 是否安全（防止 SSRF 访问内网/元数据服务）
 *
 * 默认拒绝：loopback、私网、链路本地、CGNAT、已知元数据 hostname。
 * 如需访问内网图片服务，设置环境变量 ALLOW_PRIVATE_NETWORK_IMAGES=1
 */
export function isAllowedUrl(url: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "URL 解析失败" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `不允许的协议: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // 去掉 IPv6 方括号

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    return { allowed: false, reason: `不允许的 hostname: ${hostname}` };
  }

  if (net.isIPv4(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { allowed: false, reason: `不允许的内网 IP: ${hostname}` };
    }
  } else if (net.isIPv6(hostname)) {
    if (isPrivateIPv6(hostname)) {
      return { allowed: false, reason: `不允许的内网 IP: ${hostname}` };
    }
  }

  return { allowed: true };
}

function isPrivateIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

/**
 * 创建安全的 DNS lookup 函数：解析后校验所有 IP，拒绝内网地址。
 *
 * 防止 DNS rebinding 攻击：攻击者控制域名，第一次解析返回公网 IP 通过校验，
 * 第二次解析返回内网 IP 绕过校验。本函数返回第一个校验过的 IP，强制 axios
 * 用这个 IP 连接，不再重新解析。
 */
function createSafeLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    options: dns.LookupOneOptions,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
  ) => {
    const lookupOpts = { ...options, all: true } as dns.LookupAllOptions;
    dns.lookup(hostname, lookupOpts, (err, addresses) => {
      if (err) {
        callback(err as NodeJS.ErrnoException, "", 0);
        return;
      }
      const list = (addresses || []) as LookupAddress[];
      if (list.length === 0) {
        callback(
          new Error(`DNS 解析无结果: ${hostname}`) as NodeJS.ErrnoException,
          "",
          0
        );
        return;
      }
      if (!allowPrivate) {
        for (const addr of list) {
          if (isPrivateIP(addr.address)) {
            callback(
              new Error(
                `域名 ${hostname} 解析到内网 IP: ${addr.address}`
              ) as NodeJS.ErrnoException,
              "",
              0
            );
            return;
          }
        }
      }
      const first = list[0];
      callback(null, first.address, first.family);
    });
  };
}

export function detectMimeTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_MIME_TYPES[ext as keyof typeof SUPPORTED_MIME_TYPES] ?? "image/jpeg";
}

export function detectMimeTypeFromContentType(contentType: string | undefined): string {
  if (!contentType) return "image/jpeg";
  const base = contentType.split(";")[0].trim().toLowerCase();
  const known = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"];
  return known.includes(base) ? base : "image/jpeg";
}

export function imageBufferToDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function loadLocalImage(filePath: string): Promise<ImageLoadResult> {
  let stats: Stats;
  try {
    stats = await fs.stat(filePath);
  } catch (err) {
    throw new Error(`无法访问本地文件: ${filePath} (${(err as Error).message})`);
  }
  if (!stats.isFile()) {
    throw new Error(`路径不是文件: ${filePath}`);
  }
  const buffer = await fs.readFile(filePath);
  const mimeType = detectMimeTypeFromPath(filePath);
  return {
    dataUrl: imageBufferToDataUrl(buffer, mimeType),
    mimeType,
    sizeBytes: buffer.length,
  };
}

export async function downloadImage(url: string): Promise<ImageLoadResult> {
  // SSRF 防护：默认拒绝内网/loopback/元数据地址
  const allowPrivateRaw = (process.env.ALLOW_PRIVATE_NETWORK_IMAGES || "").toLowerCase();
  const allowPrivate = allowPrivateRaw === "1" || allowPrivateRaw === "true";
  if (!allowPrivate) {
    const check = isAllowedUrl(url);
    if (!check.allowed) {
      throw new Error(
        `${check.reason}（如需访问内网图片，设置环境变量 ALLOW_PRIVATE_NETWORK_IMAGES=1）`
      );
    }
  }

  try {
    // 自定义 DNS 解析：校验所有解析到的 IP，防止 DNS rebinding 绕过 SSRF 防护。
    // 通过 httpAgent/httpsAgent 传入，axios 会把它们传给底层 http.request。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safeLookup = createSafeLookup(allowPrivate) as any;
    const httpAgent = new http.Agent({ lookup: safeLookup });
    const httpsAgent = new https.Agent({ lookup: safeLookup });
    const config: AxiosRequestConfig = {
      responseType: "arraybuffer",
      timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
      maxContentLength: IMAGE_MAX_SIZE_BYTES,
      maxRedirects: 5,
      httpAgent,
      httpsAgent,
    };
    const response = await axios.get(url, config);
    const buffer = Buffer.from(response.data);
    const contentType = response.headers?.["content-type"];
    const mimeType = detectMimeTypeFromContentType(
      typeof contentType === "string" ? contentType : undefined
    );
    return {
      dataUrl: imageBufferToDataUrl(buffer, mimeType),
      mimeType,
      sizeBytes: buffer.length,
    };
  } catch (err) {
    if (err instanceof axios.AxiosError) {
      if (err.response) {
        throw new Error(`下载图片失败: HTTP ${err.response.status} ${err.response.statusText} - ${url}`);
      }
      if (err.code === "ECONNABORTED") {
        throw new Error(`下载图片超时 (${IMAGE_DOWNLOAD_TIMEOUT_MS}ms): ${url}`);
      }
      throw new Error(`下载图片失败: ${err.message} - ${url}`);
    }
    throw new Error(`下载图片失败: ${(err as Error).message} - ${url}`);
  }
}

export async function loadImageAsDataUrl(input: string): Promise<ImageLoadResult> {
  if (isHttpUrl(input)) {
    return downloadImage(input);
  }
  return loadLocalImage(input);
}
