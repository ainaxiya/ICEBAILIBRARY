import { describe, expect, it } from "vitest";
import {
  normalizeAddress,
  normalizeLocaleField,
  normalizePostalCode,
  normalizeRegion,
  normalizeTimezone,
  normalizeWebsiteField,
} from "@/lib/profile-fields";
import { composeRegionText, isSupportedCountryCode, isValidTimeZone } from "@/lib/regions";

// b25：会员资料地区分列 + 地址/邮编/网站/语言/时区 的共用校验（前后台同一套口径）

describe("地区分列", () => {
  it("支持首批 20 国，非法代码被拒绝", () => {
    expect(isSupportedCountryCode("CN")).toBe(true);
    expect(isSupportedCountryCode("US")).toBe(true);
    expect(isSupportedCountryCode("ZZ")).toBe(false);
    expect(normalizeRegion({ countryCode: "ZZ" }).error).toBeTruthy();
  });

  it("四列写入并按「国家 省 市 区」回填 nationality", () => {
    const r = normalizeRegion({
      countryCode: "us",
      province: "California",
      city: "Los Angeles",
      district: " ",
    });
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({
      countryCode: "US",
      province: "California",
      city: "Los Angeles",
      district: null,
      nationality: "美国 California Los Angeles",
    });
  });

  it("清空国家时 nationality 同步清空", () => {
    const r = normalizeRegion({ countryCode: "", province: "", city: "", district: "" });
    expect(r.error).toBeUndefined();
    expect(r.data?.nationality).toBeNull();
  });

  it("超长省州名被拒绝", () => {
    const r = normalizeRegion({ countryCode: "US", province: "x".repeat(51) });
    expect(r.error).toContain("过长");
  });

  it("旧数据兼容： nationality 拼接与地区一致", () => {
    expect(
      composeRegionText({ countryCode: "CN", province: "广东省", city: "深圳市", district: "南山区" })
    ).toBe("中国 广东省 深圳市 南山区");
  });
});

describe("地址 / 邮编 / 网站 / 语言 / 时区", () => {
  it("地址与邮编按上限校验", () => {
    expect(normalizeAddress(" 广东省深圳市南山区 1 号 ").value).toBe("广东省深圳市南山区 1 号");
    expect(normalizeAddress("x".repeat(201)).error).toBeTruthy();
    expect(normalizePostalCode("518000").value).toBe("518000");
    expect(normalizePostalCode("1".repeat(21)).error).toBeTruthy();
  });

  it("网站自动补 https 并拒绝非法地址", () => {
    expect(normalizeWebsiteField("example.com").value).toBe("https://example.com/");
    expect(normalizeWebsiteField("http://a.b/c").value).toBe("http://a.b/c");
    expect(normalizeWebsiteField("javascript:alert(1)").error).toBeTruthy();
    expect(normalizeWebsiteField("").value).toBeNull();
  });

  it("语言偏好只接受列表内取值", () => {
    expect(normalizeLocaleField("zh-CN").value).toBe("zh-CN");
    expect(normalizeLocaleField("xx-YY").error).toBeTruthy();
  });

  it("时区按 IANA 校验", () => {
    expect(normalizeTimezone("Asia/Shanghai").value).toBe("Asia/Shanghai");
    expect(normalizeTimezone("Mars/Olympus").error).toBeTruthy();
    expect(isValidTimeZone("UTC")).toBe(true);
  });
});
