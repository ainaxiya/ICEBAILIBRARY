import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getOptimizerConfig } from "@/lib/settings";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/optimize —— 神器·全能提示词优化器（流式版）
// 把用户大白话交给 DeepSeek（system prompt = 优化技能文档）重构为专业级提示词
// 限流：每 IP 每 5 分钟 10 次（对外免费工具，防止 API 额度被刷）
// 使用记录：每次调用写一条 OptimizerLog（IP/时间/输入/输出或错误），仅供后台查看，不落账号
//
// 流式协议（application/x-ndjson，每行一个 JSON 事件）：
//   {"s":1}       流开始（响应头立即返回）
//   {"d":"片段"}   优化结果增量文本
//   {"e":"错误"}   错误（流终止）
// 为什么流式：站点经腾讯云 EdgeOne CDN 回源，非流式响应生成耗时 20-40 秒会被 CDN
// 提前掐断回源连接（nginx 记 499），前端拿不到 JSON 只能报"优化失败"，而服务端
// 实际已生成成功并落库；流式让响应头秒回、增量持续推送，CDN 不再超时。
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (!rateLimit(`optimize:${ip}`, 10, 5 * 60 * 1000)) {
    return NextResponse.json(
      { error: "操作太频繁，请稍后再试（每 5 分钟最多 10 次）" },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => null);
  const text = ((body?.text as string) || "").trim();
  // 来源标记：home=首页神器区 / shenqi=单页工具页（非法值兜底 home）
  const source = body?.source === "shenqi" ? "shenqi" : "home";
  if (!text) return NextResponse.json({ error: "请输入要优化的内容" }, { status: 400 });
  if (text.length > 8000) {
    return NextResponse.json({ error: "内容过长，请控制在 8000 字以内" }, { status: 400 });
  }

  // 使用记录：成功记 output，失败记 error（fire-and-forget，不阻塞响应）
  function record(err: string, out: string = "") {
    db.optimizerLog
      .create({ data: { ip, source, input: text, output: out, error: err } })
      .catch(() => {});
  }

  const cfg = await getOptimizerConfig();
  if (!cfg.apiKey) {
    record("优化器暂未配置模型 API，请联系管理员在后台配置");
    return NextResponse.json(
      { error: "优化器暂未配置模型 API，请联系管理员在后台配置" },
      { status: 503 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: cfg.systemPrompt },
          { role: "user", content: text },
        ],
        temperature: 0.7,
        max_tokens: 65536,
        stream: true,
      }),
      signal: AbortSignal.timeout(300000),
    });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "模型响应超时，请重试" : (e as Error).message;
    record(`优化失败：${msg}`);
    return NextResponse.json({ error: `优化失败：${msg}` }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const data = await upstream.json().catch(() => ({}));
    const errMsg = `模型服务返回错误（HTTP ${upstream.status}）：${(data.error?.message || "").slice(0, 200)}`;
    record(errMsg);
    return NextResponse.json({ error: errMsg }, { status: 502 });
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const upstreamReader = upstream.body.getReader();
  let full = "";
  let sseBuf = "";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      send({ s: 1 });
      try {
        for (;;) {
          const { done, value } = await upstreamReader.read();
          if (done) break;
          sseBuf += dec.decode(value, { stream: true });
          const lines = sseBuf.split("\n");
          sseBuf = lines.pop() || "";
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const piece: string = j.choices?.[0]?.delta?.content || "";
              if (piece) {
                full += piece;
                send({ d: piece });
              }
            } catch {
              // 忽略无法解析的心跳/元数据行
            }
          }
        }
        if (!full) {
          record("模型未返回内容，请重试");
          send({ e: "模型未返回内容，请重试" });
        } else {
          record("", full);
        }
      } catch (e) {
        const msg = (e as Error).name === "TimeoutError" ? "模型响应超时，请重试" : (e as Error).message;
        record(`优化失败：${msg}`, full);
        send({ e: `优化失败：${msg}` });
      } finally {
        controller.close();
      }
    },
    cancel() {
      upstreamReader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
