import dns from "dns/promises";
import net from "net";

// ─── 出站抓取防护（SSRF）───
// 与 src/lib/assets.ts 原实现同源，抽成共用模块供「产物转存」「实验场媒体落盘」复用，
// 全站只保留这一套私网判定 / 限跳重定向 / 下载体积上限逻辑。

// 重定向跳数与默认响应体大小上限
export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

// 私网/保留地址判断（含 IPv4-mapped IPv6 与云 metadata 169.254.169.254）
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local（含云 metadata）
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  if (v6.startsWith("fc") || v6.startsWith("fd")) return true; // ULA
  if (v6.startsWith("fe80")) return true; // link-local
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7)); // v4-mapped
  return false;
}

// 主机必须是公网地址：字面 IP 直接判；域名解析后逐地址判
export async function assertPublicHost(hostname: string): Promise<void> {
  if (/^localhost$/i.test(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("SSRF blocked: localhost");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error("SSRF blocked: private address");
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("产物地址 DNS 解析失败");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("SSRF blocked: private address");
  }
}

// 手动跟随重定向（每跳重新校验协议与目标地址，含最终地址），防止 3xx 绕过私网校验
export async function fetchWithSsrfGuard(
  url: URL,
  opts: { timeoutMs?: number } = {}
): Promise<Response> {
  let current = url;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("仅允许 http(s) 产物地址");
    }
    await assertPublicHost(current.hostname);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 301 && res.status <= 308) {
      const loc = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!loc) throw new Error("重定向缺少 Location");
      current = new URL(loc, current);
      continue;
    }
    return res;
  }
  throw new Error("产物下载重定向次数过多");
}

// 流式读取响应体，超上限即中断（不把超大响应整块读进内存）
export async function readBodyCapped(
  res: Response,
  maxBytes: number = DEFAULT_MAX_DOWNLOAD_BYTES
): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) {
    res.body?.cancel().catch(() => {});
    throw new Error("产物体积超过下载上限");
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Error("产物体积超过下载上限");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
