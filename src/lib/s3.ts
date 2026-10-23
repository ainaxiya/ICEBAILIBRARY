import {
  S3Client,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { decryptSecret } from "./crypto";
import type { StorageBucket } from "@prisma/client";

// S3/MinIO 封装：统一从 StorageBucket 行构建客户端
export type BucketConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string; // 已解密
  publicBaseUrl: string | null;
};

export function bucketToConfig(b: StorageBucket): BucketConfig {
  return {
    endpoint: b.endpoint,
    region: b.region || "us-east-1",
    bucket: b.bucket,
    accessKey: b.accessKey,
    secretKey: decryptSecret(b.secretKey),
    publicBaseUrl: b.publicBaseUrl,
  };
}

export function makeS3(cfg: BucketConfig): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: true, // MinIO 必须 path-style；S3 兼容
  });
}

// 测试连接：HeadBucket + 列前 5 个对象
export async function testBucket(cfg: BucketConfig): Promise<{ ok: boolean; error?: string; sampleKeys?: string[] }> {
  try {
    const s3 = makeS3(cfg);
    await s3.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    const list = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 5 }));
    return { ok: true, sampleKeys: (list.Contents || []).map((o) => o.Key || "") };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// 预签名直传（PUT，默认 5 分钟有效）
export async function presignUpload(cfg: BucketConfig, key: string, contentType: string, expires = 300): Promise<string> {
  const s3 = makeS3(cfg);
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }), { expiresIn: expires });
}

// 预签名下载（GET，60 秒有效，防外链盗链）
export async function presignDownload(cfg: BucketConfig, key: string, expires = 60): Promise<string> {
  const s3 = makeS3(cfg);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { expiresIn: expires });
}

export async function deleteObject(cfg: BucketConfig, key: string): Promise<void> {
  const s3 = makeS3(cfg);
  await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}
