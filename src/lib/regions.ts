// 会员资料页地区数据：首批 20 国（ISO2 + 中文名），数据文件位于 public/region/<ISO2>.json
// 中国使用 public/region/pca.json（省/市/区三级），其余国家为「省/州 → 城市」两级。

export type RegionNode = { code: string; name: string; children?: RegionNode[] };

export type RegionValue = {
  countryCode: string;
  province: string;
  city: string;
  district: string;
};

export const REGION_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "CN", name: "中国" },
  { code: "US", name: "美国" },
  { code: "JP", name: "日本" },
  { code: "KR", name: "韩国" },
  { code: "SG", name: "新加坡" },
  { code: "MY", name: "马来西亚" },
  { code: "TH", name: "泰国" },
  { code: "VN", name: "越南" },
  { code: "ID", name: "印度尼西亚" },
  { code: "PH", name: "菲律宾" },
  { code: "IN", name: "印度" },
  { code: "GB", name: "英国" },
  { code: "DE", name: "德国" },
  { code: "FR", name: "法国" },
  { code: "ES", name: "西班牙" },
  { code: "IT", name: "意大利" },
  { code: "NL", name: "荷兰" },
  { code: "AU", name: "澳大利亚" },
  { code: "CA", name: "加拿大" },
  { code: "BR", name: "巴西" },
];

const NAME_BY_CODE = new Map(REGION_COUNTRIES.map((c) => [c.code, c.name]));

export function regionCountryName(code: string | null | undefined): string {
  if (!code) return "";
  return NAME_BY_CODE.get(code.toUpperCase()) ?? "";
}

export function isSupportedCountryCode(code: string): boolean {
  return NAME_BY_CODE.has(code.toUpperCase());
}

// 兼容旧 nationality 字段：国家 省 市 区 空格连接
export function composeRegionText(v: RegionValue): string {
  const country = regionCountryName(v.countryCode);
  return [country, v.province, v.city, v.district].filter(Boolean).join(" ");
}

export const LOCALES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "it-IT", label: "Italiano" },
  { value: "pt-BR", label: "Português" },
  { value: "ru-RU", label: "Русский" },
  { value: "ar-SA", label: "العربية" },
];

export const TIMEZONES: ReadonlyArray<string> = [
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Bangkok",
  "Asia/Ho_Chi_Minh",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Kolkata",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Sao_Paulo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
