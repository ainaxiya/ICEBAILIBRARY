// 会员资料字段口径（前台 /api/user/profile 与后台 /api/admin/users/:id 共用）
// 只放限制与规范化函数，保证前后台校验一致。

import { composeRegionText, isSupportedCountryCode, isValidTimeZone, LOCALES, regionCountryName } from "@/lib/regions";

export const PROFILE_LIMITS = {
  province: 50,
  city: 50,
  district: 50,
  address: 200,
  postalCode: 20,
  website: 200,
  locale: 20,
  timezone: 64,
} as const;

export type ProfileRegionInput = {
  countryCode?: unknown;
  province?: unknown;
  city?: unknown;
  district?: unknown;
};

export function normalizeWebsite(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function normalizeLocale(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  return LOCALES.some((l) => l.value === v) ? v : null;
}

/**
 * 校验并规范化地区四列 + 兼容字段 nationality。
 * 返回 error 时调用方直接 400；返回的 data 只包含请求里出现过的字段。
 */
export function normalizeRegion(input: ProfileRegionInput):
  | { error: string; data?: undefined }
  | { error?: undefined; data: Record<string, string | null> } {
  const data: Record<string, string | null> = {};

  let countryCode: string | null | undefined;
  if (input.countryCode !== undefined) {
    const raw = typeof input.countryCode === "string" ? input.countryCode.trim().toUpperCase() : "";
    if (raw && !isSupportedCountryCode(raw)) return { error: "国家/地区代码不受支持" };
    countryCode = raw || null;
    data.countryCode = countryCode;
  }

  const textFields: Array<[keyof typeof PROFILE_LIMITS, unknown]> = [
    ["province", input.province],
    ["city", input.city],
    ["district", input.district],
  ];
  for (const [field, raw] of textFields) {
    if (raw === undefined) continue;
    if (typeof raw !== "string") return { error: `${field} 取值无效` };
    const v = raw.trim();
    if (v.length > PROFILE_LIMITS[field]) {
      return { error: `${field} 过长（最多 ${PROFILE_LIMITS[field]} 字符）` };
    }
    data[field] = v || null;
  }

  // 只要提交了 countryCode，就用新四列重算 nationality（保留旧字段给列表/导出用）
  if (countryCode !== undefined) {
    data.nationality = countryCode
      ? composeRegionText({
          countryCode,
          province: (data.province as string | null) ?? "",
          city: (data.city as string | null) ?? "",
          district: (data.district as string | null) ?? "",
        }) || regionCountryName(countryCode)
      : null;
  }

  return { data };
}

export function normalizeTimezone(raw: string): { error?: string; value?: string | null } {
  const v = raw.trim();
  if (!v) return { value: null };
  if (v.length > PROFILE_LIMITS.timezone || !isValidTimeZone(v)) {
    return { error: "时区无效" };
  }
  return { value: v };
}

export function normalizeLocaleField(raw: string): { error?: string; value?: string | null } {
  const v = raw.trim();
  if (!v) return { value: null };
  const normalized = normalizeLocale(v);
  if (!normalized) return { error: "语言偏好取值无效" };
  return { value: normalized };
}

export function normalizePostalCode(raw: string): { error?: string; value?: string | null } {
  const v = raw.trim();
  if (v.length > PROFILE_LIMITS.postalCode) {
    return { error: `邮编过长（最多 ${PROFILE_LIMITS.postalCode} 字符）` };
  }
  return { value: v || null };
}

export function normalizeAddress(raw: string): { error?: string; value?: string | null } {
  const v = raw.trim();
  if (v.length > PROFILE_LIMITS.address) {
    return { error: `详细地址过长（最多 ${PROFILE_LIMITS.address} 字符）` };
  }
  return { value: v || null };
}

export function normalizeWebsiteField(raw: string): { error?: string; value?: string | null } {
  const v = raw.trim();
  if (!v) return { value: null };
  if (v.length > PROFILE_LIMITS.website) {
    return { error: `个人网站过长（最多 ${PROFILE_LIMITS.website} 字符）` };
  }
  const normalized = normalizeWebsite(v);
  if (!normalized) return { error: "个人网站格式不正确（需 http/https 地址）" };
  return { value: normalized };
}
