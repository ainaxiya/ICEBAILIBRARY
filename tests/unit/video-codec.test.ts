import { describe, it, expect } from "vitest";
import {
  decideVideoAction,
  detectVideoContainer,
  inspectMp4VideoCodec,
  inspectVideoSource,
  planCrawlVideo,
  videoActionReason,
} from "@/lib/video-codec";

// ─── vp5/vp1 视频处置判定 ───
// 用最小 MP4 box 结构构造样本：只验证容器解析与动作判定，不需要真实视频文件。

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, payload]);
}

// 视觉 sample entry：6 字节保留 + 2 字节 data_reference_index + 70 字节固定字段 + 子 box
function sampleEntry(format: string, children: Buffer = Buffer.alloc(0)): Buffer {
  return box(
    format,
    Buffer.concat([Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(70), children])
  );
}

/** faststart=true → ftyp, moov, mdat；false → ftyp, mdat, moov */
function mp4(
  format: string,
  opts: { handler?: string; avcProfile?: number; faststart?: boolean } = {}
): Buffer {
  const handler = opts.handler ?? "vide";
  const children =
    format.startsWith("avc") && opts.avcProfile != null
      ? box("avcC", Buffer.from([1, opts.avcProfile, 0, 0x1f, 0xff, 0xe1]))
      : Buffer.alloc(0);
  const stsd = box(
    "stsd",
    Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), sampleEntry(format, children)])
  );
  const stbl = box("stbl", stsd);
  const minf = box("minf", stbl);
  const hdlr = box(
    "hdlr",
    Buffer.concat([Buffer.alloc(8), Buffer.from(handler, "latin1"), Buffer.alloc(13)])
  );
  const mdia = box("mdia", Buffer.concat([hdlr, minf]));
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  const ftyp = box("ftyp", Buffer.from("isom\x00\x00\x02\x00isomiso2mp41", "latin1"));
  const mdat = box("mdat", Buffer.alloc(16, 0x21));
  return opts.faststart === false
    ? Buffer.concat([ftyp, mdat, moov])
    : Buffer.concat([ftyp, moov, mdat]);
}

/** 最小 WebM/EBML 头（判定只看前 4 字节） */
function webm(): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(24)]);
}

describe("video-codec 容器与编码解析", () => {
  it("识别 MP4（ftyp）与 WebM（EBML）容器", () => {
    expect(detectVideoContainer(mp4("avc1", { avcProfile: 100 }))).toBe("mp4");
    expect(detectVideoContainer(webm())).toBe("webm");
    expect(detectVideoContainer(Buffer.from("not a video"))).toBe("unknown");
  });

  it("H.264 High（profile 100）与 faststart 位置解析正确", () => {
    const fast = inspectVideoSource(mp4("avc1", { avcProfile: 100 }));
    expect(fast.codec).toMatchObject({ codec: "avc1", family: "avc", profileIdc: 100 });
    expect(fast.faststart).toBe(true);

    const slow = inspectVideoSource(mp4("avc1", { avcProfile: 100, faststart: false }));
    expect(slow.faststart).toBe(false);
  });
});

describe("decideVideoAction 处置动作", () => {
  it("H.264 8-bit + faststart 正常 → 原样通过（不解码、不 remux）", () => {
    for (const profile of [66, 77, 88, 100]) {
      const info = inspectVideoSource(mp4("avc1", { avcProfile: profile }));
      expect(decideVideoAction(info)).toBe("pass");
    }
  });

  it("H.264 8-bit 缺 faststart → 只 remux", () => {
    const info = inspectVideoSource(mp4("avc1", { avcProfile: 100, faststart: false }));
    expect(decideVideoAction(info)).toBe("remux");
  });

  it("H.264 非 8-bit（10-bit / 4:2:2 / 4:4:4）→ 转码", () => {
    for (const profile of [44, 110, 122, 244, 144]) {
      const info = inspectVideoSource(mp4("avc1", { avcProfile: profile }));
      expect(decideVideoAction(info)).toBe("transcode");
    }
  });

  it("HEVC（hvc1 / hev1）→ 转码", () => {
    expect(decideVideoAction(inspectVideoSource(mp4("hvc1")))).toBe("transcode");
    expect(decideVideoAction(inspectVideoSource(mp4("hev1")))).toBe("transcode");
  });

  it("ProRes / MPEG-4 Part 2 / MP4 内 AV1、VP9 → 转码", () => {
    for (const format of ["apch", "apcn", "mp4v", "av01", "vp09"]) {
      expect(decideVideoAction(inspectVideoSource(mp4(format)))).toBe("transcode");
    }
  });

  it("WebM 原样通过（iPhone Safari 实测可播 VP9）", () => {
    const info = inspectVideoSource(webm());
    expect(info).toMatchObject({ container: "webm", codec: null, faststart: null });
    expect(decideVideoAction(info)).toBe("pass");
  });

  it("纯音频轨 / 未知 sample entry / 缺 avcC → 放行", () => {
    expect(decideVideoAction(inspectVideoSource(mp4("mp4a", { handler: "soun" })))).toBe("pass");
    expect(decideVideoAction(inspectVideoSource(mp4("zzzz")))).toBe("pass");
    expect(decideVideoAction(inspectVideoSource(mp4("avc1")))).toBe("pass");
  });

  it("解析失败（非 MP4 结构 / 截断 / 空）一律放行", () => {
    expect(inspectMp4VideoCodec(Buffer.from("not an mp4 file at all"))).toBeNull();
    expect(decideVideoAction(inspectVideoSource(Buffer.alloc(0)))).toBe("pass");
    const truncated = mp4("hvc1").subarray(0, 24);
    expect(decideVideoAction(inspectVideoSource(truncated))).toBe("pass");
  });

  it("动作说明能落到具体原因", () => {
    expect(videoActionReason(inspectVideoSource(mp4("hvc1")), "transcode")).toContain("hvc1");
    expect(
      videoActionReason(inspectVideoSource(mp4("avc1", { avcProfile: 110 })), "transcode")
    ).toContain("非 8-bit");
    expect(
      videoActionReason(inspectVideoSource(mp4("avc1", { avcProfile: 100, faststart: false })), "remux")
    ).toContain("faststart");
  });
});

describe("planCrawlVideo 采集落盘计划", () => {
  it("WebM 原样落 .webm", () => {
    expect(planCrawlVideo(inspectVideoSource(webm()), "mp4")).toEqual({ action: "pass", ext: "webm" });
  });

  it("合格 H.264 MP4 原样落 .mp4；缺 faststart 走 remux；HEVC 走 transcode", () => {
    expect(planCrawlVideo(inspectVideoSource(mp4("avc1", { avcProfile: 100 })), null)).toEqual({
      action: "pass",
      ext: "mp4",
    });
    expect(
      planCrawlVideo(inspectVideoSource(mp4("avc1", { avcProfile: 100, faststart: false })), null)
    ).toEqual({ action: "remux", ext: "mp4" });
    expect(planCrawlVideo(inspectVideoSource(mp4("hvc1")), null)).toEqual({
      action: "transcode",
      ext: "mp4",
    });
  });

  it("未知容器：有可靠扩展名原样落盘，否则按旧逻辑 remux", () => {
    const info = inspectVideoSource(Buffer.from("unknown container bytes"));
    expect(planCrawlVideo(info, "mp4")).toEqual({ action: "pass", ext: "mp4" });
    expect(planCrawlVideo(info, null)).toEqual({ action: "remux", ext: "mp4" });
  });
});
