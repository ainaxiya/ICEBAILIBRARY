import { describe, expect, it } from "vitest";
import {
  genericPricing,
  videoPerSecondCostCredits,
  videoPerSecondMemberCredits,
  videoTaskMemberCredits,
} from "@/lib/gateway/pricing";

// 锁定 v6「视频统一按秒价」口径：
// - 只认通用行（variant = ""），历史分辨率档位行不再参与计价
// - 成本 ￥/秒 × 汇率 × 100 = 成本积分/秒
// - 会员积分/秒：优先后台直填，否则成本 × 倍率；两项都空 = 未定价（null，不按 1 分兜底）

type Row = {
  id: number;
  variant: string;
  unit: string;
  meterBase: number;
  inputPrice: number;
  outputPrice: number;
  fxRateE8: bigint;
  multiplierBps: number;
  memberInputPrice: number | null;
  memberOutputPrice: number | null;
  effectiveAt: Date;
};

const row = (patch: Partial<Row> = {}): Row => ({
  id: 1,
  variant: "",
  unit: "video_second",
  meterBase: 1,
  inputPrice: 0.04,
  outputPrice: 0,
  fxRateE8: 100_000_000n,
  multiplierBps: 15000,
  memberInputPrice: null,
  memberOutputPrice: null,
  effectiveAt: new Date("2026-01-01T00:00:00Z"),
  ...patch,
});

describe("genericPricing：视频只认通用行", () => {
  it("多条通用行取最新生效的一条", () => {
    const picked = genericPricing({
      pricings: [
        row({ id: 1, inputPrice: 0.02, effectiveAt: new Date("2026-01-01T00:00:00Z") }),
        row({ id: 2, inputPrice: 0.05, effectiveAt: new Date("2026-02-01T00:00:00Z") }),
      ],
    });
    expect(picked?.id).toBe(2);
  });

  it("只有历史分辨率档位行时返回 null（不拿档位价当默认价）", () => {
    const picked = genericPricing({
      pricings: [
        row({ id: 1, variant: "720p:n", inputPrice: 1 }),
        row({ id: 2, variant: "720p:v", inputPrice: 4.24 }),
        row({ id: 3, variant: "1080p:n", inputPrice: 2.478 }),
      ],
    });
    expect(picked).toBeNull();
  });

  it("通用行与档位行混存时只取通用行", () => {
    const picked = genericPricing({
      pricings: [
        row({ id: 1, variant: "480p:n", inputPrice: 0.45, effectiveAt: new Date("2026-03-01T00:00:00Z") }),
        row({ id: 2, inputPrice: 0.06, effectiveAt: new Date("2026-01-01T00:00:00Z") }),
      ],
    });
    expect(picked?.id).toBe(2);
  });

  it("没有定价行 / 空模型返回 null", () => {
    expect(genericPricing({ pricings: [] })).toBeNull();
    expect(genericPricing(null)).toBeNull();
  });

  it("未来生效的通用行：无已生效行时回退最近一条（与 latestPricing 一致）", () => {
    const picked = genericPricing({
      pricings: [row({ id: 9, effectiveAt: new Date(Date.now() + 86_400_000) })],
    });
    expect(picked?.id).toBe(9);
  });
});

describe("videoPerSecondCostCredits：成本 ￥/秒 → 积分/秒", () => {
  it("0.04 元/秒 = 4 积分/秒", () => {
    expect(videoPerSecondCostCredits(row({ inputPrice: 0.04 }))).toBeCloseTo(4, 6);
  });

  it("外币按汇率换算（1 USD = 7.2 元）", () => {
    const usd = row({ inputPrice: 0.01, fxRateE8: 720_000_000n });
    expect(videoPerSecondCostCredits(usd)).toBeCloseTo(7.2, 6);
  });

  it("成本为 0 / 空 / 非视频秒单位 / 无定价 → null", () => {
    expect(videoPerSecondCostCredits(row({ inputPrice: 0 }))).toBeNull();
    expect(videoPerSecondCostCredits(null)).toBeNull();
    expect(videoPerSecondCostCredits(row({ unit: "image" }))).toBeNull();
  });
});

describe("videoPerSecondMemberCredits：会员积分/秒", () => {
  it("后台直填会员价优先，ceil 取整", () => {
    expect(videoPerSecondMemberCredits(row({ memberInputPrice: 40.02 }))).toBe(41);
    expect(videoPerSecondMemberCredits(row({ memberInputPrice: 40 }))).toBe(40);
  });

  it("未填会员价时按成本 × 倍率折算（0.04 × 100 × 1.5 = 6）", () => {
    expect(videoPerSecondMemberCredits(row({ inputPrice: 0.04, multiplierBps: 15000 }))).toBe(6);
  });

  it("成本与会员价都留空 = 未定价，返回 null（不按最低 1 分兜底）", () => {
    expect(videoPerSecondMemberCredits(row({ inputPrice: 0, memberInputPrice: null }))).toBeNull();
  });

  it("非视频秒单位 / 无定价 → null", () => {
    expect(videoPerSecondMemberCredits(row({ unit: "request", memberInputPrice: 10 }))).toBeNull();
    expect(videoPerSecondMemberCredits(undefined)).toBeNull();
  });
});

describe("videoTaskMemberCredits：任务总积分 = 每秒积分 × 秒数", () => {
  it("5 秒 × 40 积分/秒 = 200", () => {
    expect(videoTaskMemberCredits(row({ memberInputPrice: 40 }), 5)).toBe(200);
  });

  it("小数秒价先按秒 ceil 再乘秒数", () => {
    // 40.02 → 41；3 秒 → 123
    expect(videoTaskMemberCredits(row({ memberInputPrice: 40.02 }), 3)).toBe(123);
  });

  it("未定价任务返回 null（调用方据此拒绝下单）", () => {
    expect(videoTaskMemberCredits(row({ inputPrice: 0, memberInputPrice: null }), 5)).toBeNull();
  });

  it("秒数缺失 / 0 / 负数 → null", () => {
    expect(videoTaskMemberCredits(row(), 0)).toBeNull();
    expect(videoTaskMemberCredits(row(), -1)).toBeNull();
    expect(videoTaskMemberCredits(row(), Number.NaN)).toBeNull();
  });
});
