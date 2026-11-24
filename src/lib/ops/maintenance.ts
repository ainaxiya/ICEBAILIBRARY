// ─── P6 #22 实验场维护开关 ───
// 存 SiteSetting key="playground_maintenance"（重启不丢）：
// 开启后创建新任务立即返回 503 + 维护提示；已在跑的任务不受影响。
import { db } from "@/lib/db";

export const PLAYGROUND_MAINTENANCE_KEY = "playground_maintenance";
export const DEFAULT_MAINTENANCE_MESSAGE =
  "实验场维护中，暂时无法创建新任务；已提交的任务会继续执行完成。";

export interface MaintenanceState {
  enabled: boolean;
  message: string;
  updatedAt: string | null;
}

const DEFAULT_STATE: MaintenanceState = {
  enabled: false,
  message: DEFAULT_MAINTENANCE_MESSAGE,
  updatedAt: null,
};

export async function getPlaygroundMaintenance(): Promise<MaintenanceState> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: PLAYGROUND_MAINTENANCE_KEY } });
    if (!row) return DEFAULT_STATE;
    const p = JSON.parse(row.value) as Partial<MaintenanceState>;
    return {
      enabled: p.enabled === true,
      message: typeof p.message === "string" && p.message.trim() ? p.message : DEFAULT_MAINTENANCE_MESSAGE,
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null,
    };
  } catch {
    // 读不到配置时按「未维护」处理，避免误伤正常下单
    return DEFAULT_STATE;
  }
}

export async function setPlaygroundMaintenance(input: {
  enabled: boolean;
  message?: string;
}): Promise<MaintenanceState> {
  const state: MaintenanceState = {
    enabled: input.enabled === true,
    message:
      typeof input.message === "string" && input.message.trim()
        ? input.message.trim().slice(0, 200)
        : DEFAULT_MAINTENANCE_MESSAGE,
    updatedAt: new Date().toISOString(),
  };
  await db.siteSetting.upsert({
    where: { key: PLAYGROUND_MAINTENANCE_KEY },
    update: { value: JSON.stringify(state) },
    create: { key: PLAYGROUND_MAINTENANCE_KEY, value: JSON.stringify(state) },
  });
  return state;
}
