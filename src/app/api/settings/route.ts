import { NextResponse } from "next/server";
import { getSettings, getPublicSite } from "@/lib/settings";

export const dynamic = "force-dynamic";

// 公开配置：发布页/注册页使用，不含敏感信息
export async function GET() {
  const s = await getSettings();
  const site = await getPublicSite();
  return NextResponse.json({
    basic: {
      siteName: site.siteName,
      logoIcon: site.logoIcon || "/logo/icon.png",
      allowRegister: site.allowRegister,
    },
    // 注册页动态字段配置（off/optional/required）
    registerFields: site.registerFields,
    // P7 注册需邮箱验证码（前台注册页据此渲染邮箱+验证码输入）
    emailVerifyRequired: site.emailVerifyRequired,
    // P7 邮箱找回密码可用状态（前台找回密码页据此渲染）
    emailResetEnabled: !!s.email?.enabled && !!s.email?.resetPasswordVerify,
    publish: s.publish,
    membership: s.membership,
  });
}
