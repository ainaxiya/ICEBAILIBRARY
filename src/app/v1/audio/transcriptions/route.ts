import type { NextRequest } from "next/server";
import { handleAudioStt } from "@/lib/gateway/audio";

export const dynamic = "force-dynamic";

// ─── POST /v1/audio/transcriptions —— P4 #21 语音转文字（OpenAI 兼容，multipart） ───
// 共享逻辑见 lib/gateway/audio.ts handleAudioStt：预扣按文件大小粗估分钟，
// 结算按上游 duration（verbose_json）多退少补；仅 openai 协议上游。
export async function POST(req: NextRequest) {
  return handleAudioStt(req, "transcriptions");
}
