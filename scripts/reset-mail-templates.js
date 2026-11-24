// 清空本地 email_template 旧默认行（新蓝模板部署后由 ensureTemplate 按新默认重新种入）
// 同时生成一封渲染后的预览 HTML（用与 mailer.ts 相同的内联结构 + 演示变量），供浏览器视觉确认
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: { db: { url: "postgresql://postgres@127.0.0.1:5432/prompthub?schema=public" } },
});

const interpolate = (text, vars) =>
  text.replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? "" : String(vars[k])));

const shell = (inner, siteName = "{{siteName}}") => `
<div style="background:linear-gradient(160deg,#0a1128 0%,#0d1a3a 55%,#0f2547 100%);padding:28px 12px;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:linear-gradient(90deg,#2563eb,#3b82f6);border-radius:16px 16px 0 0;padding:18px 24px;">
      <span style="color:#ffffff;font-weight:700;font-size:18px;letter-spacing:1px;">${siteName}</span>
      <span style="float:right;color:#bfdbfe;font-size:12px;padding-top:5px;">AI 资料库 · 冰山</span>
    </div>
    <div style="background:linear-gradient(180deg,#101d3d,#0c1730);border:1px solid rgba(59,130,246,0.35);border-top:none;border-radius:0 0 16px 16px;padding:28px 24px;">
      ${inner}
    </div>
    <div style="padding:16px 8px;color:#5b7bb2;font-size:12px;line-height:1.8;text-align:center;">
      没有收到？请检查邮箱的垃圾邮件箱。<br/>
      本邮件由 {{siteName}} 系统自动发送，请勿直接回复（{{year}}）
    </div>
  </div>
</div>`;

const codeBlock = `
      <p style="margin:0 0 14px;color:#dbeafe;font-size:15px;">你好！你正在进行「{{reason}}」操作，验证码为：</p>
      <div style="text-align:center;margin:24px 0;">
        <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:8px;color:#ffffff;background:linear-gradient(135deg,#2563eb,#3b82f6);border-radius:14px;padding:14px 24px;box-shadow:0 8px 24px rgba(37,99,235,0.35);">{{code}}</span>
      </div>
      <p style="margin:0 0 6px;color:#93b4f5;font-size:13px;">验证码 {{minutes}} 分钟内有效，请勿泄露给任何人。</p>
      <p style="margin:0;color:#5b7bb2;font-size:13px;">如果这不是你本人的操作，请忽略本邮件。</p>`;

(async () => {
  const del = await p.emailTemplate.deleteMany({});
  console.log("deleted old rows:", del.count);
  await p.$disconnect();

  const html = interpolate(shell(codeBlock), {
    siteName: "冰山AI资料库",
    reason: "注册账号",
    code: "852741",
    minutes: 10,
    year: "2026-11-11",
  });
  fs.writeFileSync("E:/traexiangmu/提示词/temp-mail-preview.html", html);
  console.log("preview written");
})();
