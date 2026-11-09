import { uniqueNamesGenerator } from "unique-names-generator";

// ─── 注册自动取名（unique-names-generator 插件 + 中/英自定义词库）───
// 中文界面 → 中文姓名（姓 + 1~2 字名）；英文界面 → 英文姓名（First Last）。

const ZH_SURNAMES = [
  "李", "王", "张", "刘", "陈", "杨", "黄", "赵", "周", "吴", "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "罗",
  "郑", "梁", "谢", "宋", "唐", "许", "韩", "冯", "邓", "曹", "彭", "曾", "肖", "田", "董", "袁", "潘", "于", "蒋", "蔡",
  "余", "杜", "叶", "程", "苏", "魏", "吕", "丁", "任", "沈", "姚", "卢", "姜", "崔", "钟", "谭", "陆", "汪", "范", "金",
];

const ZH_GIVEN = [
  "子墨", "雨萱", "浩然", "梦琪", "思远", "婉清", "嘉懿", "睿渊", "静怡", "泽宇",
  "慕白", "星河", "若曦", "沐辰", "语嫣", "楚寒", "亦凡", "晨曦", "诗涵", "天佑",
  "清欢", "望舒", "云舟", "青临", "映雪", "归鸿", "疏影", "芳华", "立诚", "煜祺",
  "书瑶", "瑾瑜", "念安", "南絮", "知许", "可心", "以宁", "星阑",
];

const EN_FIRST = [
  "Alex", "Sophia", "Liam", "Olivia", "Noah", "Emma", "Ava", "Ethan", "Isabella", "Lucas",
  "Mia", "Mason", "Charlotte", "Elijah", "Amelia", "Logan", "Harper", "James", "Evelyn", "Benjamin",
];

const EN_LAST = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez",
  "Hernandez", "Lopez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee",
];

// 生成随机昵称：locale 为 "en" 取英文名，其余取中文名
export function randomNickname(locale?: string | null): string {
  if (locale === "en") {
    return uniqueNamesGenerator({ dictionaries: [EN_FIRST, EN_LAST], separator: " ", length: 2 });
  }
  return uniqueNamesGenerator({ dictionaries: [ZH_SURNAMES, ZH_GIVEN], separator: "", length: 2 });
}
