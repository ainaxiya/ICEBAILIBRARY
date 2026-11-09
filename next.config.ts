import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // 关闭开发模式左下角的 Next.js DevTools 悬浮按钮（含 Preferences 面板）
  devIndicators: false,
  // 移除响应头 X-Powered-By: Next.js（避免暴露技术栈）
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
    // 中间件会缓冲请求体，默认 10MB 截断大文件上传（技能整包 zip / 软件包），放开到 250MB
    middlewareClientMaxBodySize: "250mb",
  },
  webpack: (config) => {
    // react-photo-editor 的 exports 字段只声明了 import 条件，webpack 解析失败，
    // 直接 alias 到构建产物（其内部相对引用 ./index.css 会一并解析）
    config.resolve.alias["react-photo-editor"] = path.resolve(
      "node_modules/react-photo-editor/dist/react-photo-editor.es.js"
    );
    return config;
  },
  async redirects() {
    return [
      // v0.6：/hot 下线，热门内容并入首页精选
      { source: "/hot", destination: "/", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // 禁止浏览器嗅探上传文件类型（配合上传 magic-byte 校验）
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          // HSTS：强制 HTTPS（域名已全量 https，配合 301 跳转收敛协议信号）
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      {
        // 用户上传内容：禁止作为脚本/框架执行
        source: "/uploads/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy", value: "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" },
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
