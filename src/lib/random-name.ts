// ─── 注册自动取名：网络昵称风（非真名）───
// 中文：2 字状态词 + 1~2 字主体 + 2 位数字尾缀（总长 5-6 字符，符合 2-6 要求）；
// 英文：单词 + 单词 + 2 位数字尾缀（3-20 字符）。
// 固定数字尾缀 + 拟物组合让用户一眼看出是系统自动分配的昵称。

const ZH_MODIFIERS = [
  "摸鱼", "冲浪", "熬夜", "干饭", "划水", "追风", "星河", "云端", "打盹", "蹭网",
  "满级", "氪金", "咸鱼", "蹦跶", "隐身", "电竞", "躺平", "种草", "攒钱", "逆风",
];

const ZH_SUBJECTS = [
  "猫", "兔", "鹿", "熊", "狐", "鲸", "侠", "精灵", "玩家", "达人",
  "小厨", "海豹", "企鹅", "海豚", "旅人", "奶茶", "布丁", "团子", "小鹅", "柯基",
];

const EN_MODIFIERS = [
  "Turbo", "Pixel", "Cosmic", "Ninja", "Lazy", "Hyper", "Quantum", "Cyber", "Mango", "Rocket",
  "Silent", "Lucky", "Funky", "Astro", "Echo", "Sunny", "Frosty", "Rapid", "Lunar", "Vivid",
];

const EN_SUBJECTS = [
  "Panda", "Otter", "Ranger", "Falcon", "Tiger", "Rabbit", "Wolf", "Koala", "Pilot", "Rider",
  "Wizard", "Gamer", "Drifter", "Hunter", "Camper", "Runner", "Keeper", "Racer", "Sailor", "Sparrow",
];

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const digits = () => String(10 + Math.floor(Math.random() * 90)); // 10-99

// 生成随机昵称：locale 为 "en" 取英文网络昵称，其余取中文网络昵称
export function randomNickname(locale?: string | null): string {
  if (locale === "en") {
    return `${pick(EN_MODIFIERS)}${pick(EN_SUBJECTS)}${digits()}`;
  }
  return `${pick(ZH_MODIFIERS)}${pick(ZH_SUBJECTS)}${digits()}`;
}
