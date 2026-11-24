// 导航选中态统一按「路径前缀归属」判定，避免逐页特例：
// 提示词栏目覆盖列表 / 分类 / 分类短码 / 详情 / 投稿；会员覆盖会员中心全部子页与登录、注册。
// 纯函数、只依赖当前 pathname，刷新、直接打开链接、前进后退都会得到同一结果。
const NAV_GROUPS: Record<string, string[]> = {
  "/categories": ["/categories", "/category", "/type", "/p", "/publish"],
  "/skills": ["/skills"],
  "/software": ["/software"],
  "/playground": ["/playground"],
  // 会员：会员中心全部子页 + 登录/注册 + 资料页（/user/profile，会员中心「资料」入口跳这里）
  "/member": ["/member", "/login", "/register", "/user/profile"],
};

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isNavActive(pathname: string, href: string, exact = false): boolean {
  if (exact) return pathname === href;
  const group = NAV_GROUPS[href];
  if (!group) return matchesPrefix(pathname, href);
  return group.some((p) => matchesPrefix(pathname, p));
}
