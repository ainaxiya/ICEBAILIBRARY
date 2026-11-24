import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // 关闭开发模式左下角的 Next.js DevTools 悬浮按钮（含 Preferences 面板）
  devIndicators: false,
  // 移除响应头 X-Powered-By: Next.js（避免暴露技术栈）
  poweredByHeader: false,
  // 允许用 NEXT_DIST_DIR 指定独立产物目录：本地预览时给 dev 用 .next-preview，
  // 避免 dev 产物污染待发版的 .next；未设置时保持默认 .next，线上行为不变。
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // BullMQ/ioredis 保持外部化（运行时直连 node_modules，避免打包破坏连接池/内部 require）
  serverExternalPackages: ["bullmq", "ioredis"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
    // 中间件会缓冲请求体，默认 10MB 截断大文件上传（技能整包 zip / 软件包），放开到 250MB
    middlewareClientMaxBodySize: "250mb",
  },
  webpack: (config, { webpack }) => {
    // reactjs-tiptap-editor 1.0.48 把 React 19.3.1 与 jsx-runtime 打进了自己的 lib，
    // 与 Next 的 React 形成双实例（useId 读到空 dispatcher → 后台富文本页面崩溃）。
    // 这里把这两个打包产物替换成复用应用 React 的 shim。
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^\.\/(react|jsx-runtime)-[^/\\]+\.(js|cjs)$/,
        (resource: { request: string; context?: string }) => {
          const context = String(resource.context || "").replace(/\\/g, "/");
          if (!context.includes("reactjs-tiptap-editor/lib")) return;
          const isJsxRuntime = /^\.\/jsx-runtime-/.test(resource.request);
          resource.request = path.resolve(
            isJsxRuntime ? "src/lib/tiptap-jsx-runtime-shim.mjs" : "src/lib/tiptap-react-shim.mjs"
          );
        }
      )
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
