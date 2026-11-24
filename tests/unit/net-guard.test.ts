import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHost, fetchWithSsrfGuard, readBodyCapped } from "@/lib/net-guard";
import { fetchBytes } from "@/lib/playground/media-store";

// ─── 媒体转存出站防护：私网拦截（含重定向最终地址）+ 下载体积上限 ───

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // 云 metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("拦截 %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"])("放行公网 %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("拒 localhost 与字面私网 IP", async () => {
    await expect(assertPublicHost("localhost")).rejects.toThrow(/SSRF/);
    await expect(assertPublicHost("127.0.0.1")).rejects.toThrow(/SSRF|private/);
    await expect(assertPublicHost("10.0.0.1")).rejects.toThrow(/SSRF|private/);
  });
});

describe("fetchWithSsrfGuard", () => {
  it("目标为回环地址时直接拒绝，不会真的发请求", async () => {
    await expect(fetchWithSsrfGuard(new URL("http://127.0.0.1:6379/x.png"))).rejects.toThrow(/SSRF|private/);
    await expect(fetchWithSsrfGuard(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toThrow(/SSRF|private/);
  });

  it("非 http(s) 协议拒绝", async () => {
    await expect(fetchWithSsrfGuard(new URL("file:///etc/passwd"))).rejects.toThrow(/http/);
  });
});

describe("readBodyCapped", () => {
  it("流式读取超过上限即中断", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // 3 个 8 字节块，上限 10 字节 → 第二块时超限
        ctrl.enqueue(new Uint8Array(8));
        ctrl.enqueue(new Uint8Array(8));
        ctrl.enqueue(new Uint8Array(8));
        ctrl.close();
      },
    });
    const res = new Response(stream);
    await expect(readBodyCapped(res, 10)).rejects.toThrow(/上限/);
  });

  it("content-length 超限时提前拒绝", async () => {
    const res = new Response("x", { headers: { "content-length": "999999999" } });
    await expect(readBodyCapped(res, 1024)).rejects.toThrow(/上限/);
  });

  it("未超限时完整返回", async () => {
    const res = new Response(new Uint8Array([1, 2, 3, 4]));
    const buf = await readBodyCapped(res, 1024);
    expect(buf.length).toBe(4);
  });
});

describe("媒体转存 fetchBytes", () => {
  it("data: 内联正常解码", async () => {
    const { bytes, mime } = await fetchBytes("data:image/png;base64,iVBORw0KGgo=");
    expect(mime).toBe("image/png");
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("http 指向私网 → 拒绝（不落盘）", async () => {
    await expect(fetchBytes("http://127.0.0.1:9/a.png")).rejects.toThrow(/SSRF|private/);
  });

  it("http 指向云 metadata → 拒绝", async () => {
    await expect(fetchBytes("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/SSRF|private/);
  });
});
