import { describe, expect, it } from "vitest";
import { isNavActive } from "@/lib/nav-active";

describe("底部导航选中态按路径前缀归属", () => {
  it("提示词栏目覆盖列表 / 分类 / 短码 / 详情 / 投稿", () => {
    for (const p of ["/categories", "/category", "/category/ai", "/type/text", "/p", "/p/abc123", "/publish"]) {
      expect(isNavActive(p, "/categories")).toBe(true);
    }
  });

  it("提示词栏目不会被 /privacy、/playground 误命中", () => {
    expect(isNavActive("/privacy", "/categories")).toBe(false);
    expect(isNavActive("/playground", "/categories")).toBe(false);
    expect(isNavActive("/p2p", "/categories")).toBe(false);
  });

  it("技能与实验场按前缀归属，含详情子页", () => {
    expect(isNavActive("/skills", "/skills")).toBe(true);
    expect(isNavActive("/skills/nano-banana", "/skills")).toBe(true);
    expect(isNavActive("/playground", "/playground")).toBe(true);
    expect(isNavActive("/skills", "/playground")).toBe(false);
  });

  it("会员栏目覆盖会员中心全部子页与登录 / 注册 / 资料页", () => {
    for (const p of ["/member", "/member/profile", "/member/credits", "/member/orders", "/member/messages", "/login", "/register", "/user/profile"]) {
      expect(isNavActive(p, "/member")).toBe(true);
    }
    expect(isNavActive("/", "/member")).toBe(false);
    expect(isNavActive("/user/other", "/member")).toBe(false);
  });

  it("首页只在根路径高亮", () => {
    expect(isNavActive("/", "/", true)).toBe(true);
    expect(isNavActive("/categories", "/", true)).toBe(false);
  });
});
