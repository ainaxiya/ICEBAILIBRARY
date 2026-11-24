import { describe, expect, it } from "vitest";
import { imageSizeFromBuffer } from "@/lib/playground/first-frame";
import { videoDurationFromBuffer } from "@/lib/playground/attachments";

// 只测纯解析函数：校验上游硬约束（图片 ≥300px、参考视频 ≤30s）依赖这些头部字段
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc2; // SOF2（渐进式）
  buf.writeUInt16BE(17, 4); // 段长
  buf[6] = 8; // 精度
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, payload]);
}

function mp4(seconds: number, version: 0 | 1): Buffer {
  const timescale = 1000;
  const payload =
    version === 1 ? Buffer.alloc(32) : Buffer.alloc(24);
  payload[0] = version;
  if (version === 1) {
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(Math.round(seconds * timescale)), 24);
  } else {
    payload.writeUInt32BE(timescale, 12);
    payload.writeUInt32BE(Math.round(seconds * timescale), 16);
  }
  return Buffer.concat([mp4Box("ftyp", Buffer.from("isom", "ascii")), mp4Box("moov", mp4Box("mvhd", payload))]);
}

function webm(seconds: number): Buffer {
  const scale = Buffer.from([0x2a, 0xd7, 0xb1, 0x84, 0x00, 0x0f, 0x42, 0x40]); // 1ms
  const value = Buffer.alloc(11);
  value[0] = 0x44;
  value[1] = 0x89;
  value[2] = 0x88; // 8 字节浮点
  value.writeDoubleBE(seconds * 1000, 3);
  return Buffer.concat([scale, value, Buffer.alloc(8)]);
}

describe("imageSizeFromBuffer", () => {
  it("解析 PNG / GIF / JPEG / WebP 宽高", () => {
    expect(imageSizeFromBuffer(png(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(imageSizeFromBuffer(gif(400, 300))).toEqual({ width: 400, height: 300 });
    expect(imageSizeFromBuffer(jpeg(300, 400))).toEqual({ width: 300, height: 400 });
    expect(imageSizeFromBuffer(webpVp8x(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it("无法识别的文件返回 null（调用方按「读不到尺寸」报错）", () => {
    expect(imageSizeFromBuffer(Buffer.from("not-an-image"))).toBeNull();
  });
});

describe("videoDurationFromBuffer", () => {
  it("解析 MP4 mvhd（version 0 / 1）", () => {
    expect(videoDurationFromBuffer([mp4(10.5, 0)])).toBeCloseTo(10.5, 3);
    expect(videoDurationFromBuffer([mp4(30.2, 1)])).toBeCloseTo(30.2, 3);
  });

  it("解析 WebM Duration", () => {
    expect(videoDurationFromBuffer([webm(12.25)])).toBeCloseTo(12.25, 3);
  });

  it("解析不到返回 null（不默认放过）", () => {
    expect(videoDurationFromBuffer([Buffer.from("not-a-video")])).toBeNull();
  });
});
