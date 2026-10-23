// 技能详情页链接：slug 允许重复，URL 统一采用 `slug-id` 形式按 id 精确定位
// 旧的纯 slug 链接仍可访问（同 slug 多条时取最新一条）
export function skillHref(slug: string, id: number) {
  return `/skills/${encodeURIComponent(`${slug}-${id}`)}`;
}
