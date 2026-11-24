import type { NextRequest } from "next/server";
import { handleAudioStt } from "@/lib/gateway/audio";

export const dynamic = "force-dynamic";

// ─── POST /v1/audio/translations —— P4 #21 语音翻译为英文（OpenAI 兼容，multipart） ───
// 与 transcriptions 同构（endpoint=audio_translations），共享逻辑见 handleAudioStt。
export async function POST(req: NextRequest) {
  return handleAudioStt(req, "translations");
}
