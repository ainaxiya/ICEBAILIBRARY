// ─── 站点域名统一配置（写活：业务代码禁止写死任何域名，全部从这里读）───
// 域名只在环境变量（.env）里配，改域名只动配置文件：
//   NEXT_PUBLIC_SITE_URL  主站对外主域名（宣传、canonical、sitemap、水印等统一用它）
//   API_GATEWAY_BASE_URL  API 网关域名（/v1 接口与 API 文档 Base URL 的默认值）
//   API_GATEWAY_HOSTS     /v1 网关白名单域名，逗号分隔（默认取 API_GATEWAY_BASE_URL 的域名）

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

export const SITE_URL = trimUrl(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000");

export const SITE_HOST = new URL(SITE_URL).host;

export const API_GATEWAY_BASE_URL = trimUrl(process.env.API_GATEWAY_BASE_URL || SITE_URL);

// 归一化主机名：去协议/路径/端口、转小写
const normalizeHost = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");

export const API_GATEWAY_HOSTS: string[] = (process.env.API_GATEWAY_HOSTS || API_GATEWAY_BASE_URL)
  .split(",")
  .map(normalizeHost)
  .filter(Boolean);
