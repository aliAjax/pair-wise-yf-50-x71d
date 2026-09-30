import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
  householdId?: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  localRaw?: unknown;
  remoteRaw?: unknown;
  sourceDevice?: string;
  status: "待处理" | "采用本地" | "采用远端";
}

export type BatchStatus = "待处理" | "应用中" | "已完成" | "失败";

export interface FieldOp {
  id: string;
  householdId: string;
  field: keyof Household;
  baseValue: unknown;
  remoteValue: unknown;
  deviceId: string;
  time: string;
}

export interface MergeBatch {
  id: string;
  label: string;
  deviceId: string;
  receivedAt: string;
  status: BatchStatus;
  ops: FieldOp[];
  appliedOpIds: string[];
  interruptAt?: number;
  snapshot: { households: Household[]; tasks: FieldTask[]; queue: PendingChange[]; conflicts: FieldConflict[] } | null;
  error?: string;
}

const KEY = "pair-wise-yf-50/assessment";
const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" },
  { id: "k2", householdId: "h3", title: "现场复核", assignee: "复核一组", priority: "紧急", status: "进行中", due: "2026-09-30 10:00" },
  { id: "k3", householdId: "h1", title: "现场复核", assignee: "复核二组", priority: "紧急", status: "待接收", due: "2026-09-30 14:00" }
];

// 家庭状态与版本不参与合并：定案前合并批与重复合并都不推进状态
const dataFields: (keyof Household)[] = ["head", "community", "address", "members", "vulnerable", "needLevel", "needs", "note"];
const taskRank: Record<TaskStatus, number> = { 待接收: 0, 进行中: 1, 已完成: 2 };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const displayValue = (value: unknown) => (Array.isArray(value) ? value.join("、") : String(value ?? ""));

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const batches = ref<MergeBatch[]>(initial?.batches ?? []);
  const aliases = ref<Record<string, string>>(initial?.aliases ?? {});
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  // 模拟中断只发生一次（如平板断电），续作重试时不再触发；不持久化
  const interrupted = new Set<string>();

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  const pendingBatches = computed(() => batches.value.filter((batch) => batch.status === "待处理" || batch.status === "失败").length);

  const hasPendingConflicts = (householdId: string) => conflicts.value.some((item) => item.householdId === householdId && item.status === "待处理");

  function enqueue(entity: string, action: string, detail: string, householdId?: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: new Date().toISOString(), householdId });
  }

  function pushConflict(input: Omit<FieldConflict, "id" | "status">) {
    const duplicated = conflicts.value.some((item) => item.householdId === input.householdId && item.field === input.field && item.status === "待处理" && item.localValue === input.localValue && item.remoteValue === input.remoteValue);
    if (duplicated) return; // 同一来源值冲突不重复登记
    conflicts.value.unshift({ ...input, id: crypto.randomUUID(), status: "待处理" });
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    const id = crypto.randomUUID();
    households.value.unshift({ ...input, id, status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "新增", input.head, id);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`, id);
  }

  // 复核任务随重复合并转移到保留记录；同名任务合并时进度不倒退
  function transferTasks(sourceId: string, targetId: string) {
    tasks.value.filter((task) => task.householdId === sourceId).forEach((task) => {
      const sibling = tasks.value.find((item) => item.householdId === targetId && item.title === task.title);
      if (sibling) {
        if (taskRank[task.status] > taskRank[sibling.status]) sibling.status = task.status;
        if (task.due < sibling.due) sibling.due = task.due;
        tasks.value = tasks.value.filter((item) => item.id !== task.id);
      } else {
        task.householdId = targetId;
      }
    });
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    // 字段对齐：同一字段两边都改过就保留两个来源值，未定案前不推进家庭状态
    dataFields.forEach((field) => {
      const sourceValue = source[field];
      const targetValue = target[field];
      if (sameValue(sourceValue, targetValue)) return;
      if (Array.isArray(sourceValue) && Array.isArray(targetValue)) {
        (target as unknown as Record<string, unknown>)[field] = Array.from(new Set([...targetValue, ...sourceValue]));
        return;
      }
      const targetEmpty = targetValue === "" || targetValue === 0;
      if (targetEmpty) {
        (target as unknown as Record<string, unknown>)[field] = clone(sourceValue);
        return;
      }
      pushConflict({ householdId: target.id, field, localValue: displayValue(targetValue), remoteValue: displayValue(sourceValue), localRaw: clone(targetValue), remoteRaw: clone(sourceValue), sourceDevice: "重复记录合并" });
    });
    // 任务和待同步操作一起转移到保留记录
    transferTasks(sourceId, targetId);
    queue.value.forEach((item) => {
      if (item.householdId === sourceId) item.householdId = targetId;
    });
    aliases.value[sourceId] = targetId; // 后续回站合并批中指向已消失记录的操作改投保留记录
    target.version += 1;
    target.deviceUpdatedAt = new Date().toISOString();
    households.value = households.value.filter((item) => item.id !== sourceId);
    enqueue("重复记录", "合并", `${source.head}：${source.address} → 保留 ${target.address}`, targetId);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: crypto.randomUUID(), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成" && !hasPendingConflicts(household.id)) household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`, input.householdId);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      // 未定案（存在待处理字段冲突）前不推进家庭状态
      if (household && !open && !hasPendingConflicts(household.id)) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`, task.householdId);
  }

  // 模拟另一台平板回站，生成一个合并批数据包
  function receivePackage() {
    const now = new Date().toISOString();
    const batch: MergeBatch = {
      id: crypto.randomUUID(),
      label: `平板B 回站数据包 ${new Date().toLocaleTimeString("zh-CN")}`,
      deviceId: "平板B",
      receivedAt: now,
      status: "待处理",
      appliedOpIds: [],
      snapshot: null,
      interruptAt: 2,
      ops: [
        { id: crypto.randomUUID(), householdId: "h1", field: "address", baseValue: "河湾路18号2单元", remoteValue: "河湾路18号2栋2单元", deviceId: "平板B", time: now },
        { id: crypto.randomUUID(), householdId: "h1", field: "note", baseValue: "一层受淹", remoteValue: "一层受淹，积水约30cm", deviceId: "平板B", time: now },
        { id: crypto.randomUUID(), householdId: "h2", field: "needs", baseValue: ["饮用水"], remoteValue: ["饮用水", "毛毯"], deviceId: "平板B", time: now },
        { id: crypto.randomUUID(), householdId: "h3", field: "members", baseValue: 4, remoteValue: 5, deviceId: "平板B", time: now }
      ]
    };
    batches.value.unshift(batch);
    enqueue("回站数据包", "接收", `${batch.label}（${batch.ops.length} 项字段变更）`);
    return batch.id;
  }

  // 三方字段对齐：本机值、远端基准值、远端新值逐字段比对
  function applyOp(op: FieldOp) {
    if (!dataFields.includes(op.field)) return; // 状态、版本等不随合并批写入
    const targetId = aliases.value[op.householdId] ?? op.householdId;
    const household = households.value.find((item) => item.id === targetId);
    if (!household) throw new Error(`家庭记录 ${op.householdId} 不存在，且没有可转移的保留记录`);
    const localValue = household[op.field];
    if (sameValue(localValue, op.remoteValue)) return; // 两边一致，无需写入
    if (sameValue(localValue, op.baseValue)) {
      (household as unknown as Record<string, unknown>)[op.field] = clone(op.remoteValue); // 仅远端改过，按字段应用
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
      return;
    }
    if (sameValue(op.remoteValue, op.baseValue)) return; // 仅本机改过，保留本机
    // 同一字段两边都改过：保留两个来源值，定案前不覆盖、不推进状态
    pushConflict({ householdId: household.id, field: op.field, localValue: displayValue(localValue), remoteValue: displayValue(op.remoteValue), localRaw: clone(localValue), remoteRaw: clone(op.remoteValue), sourceDevice: op.deviceId });
  }

  // 续作合并批：失败后可重试，已接收字段凭操作流水不重复写入
  function applyBatch(id: string) {
    const batch = batches.value.find((item) => item.id === id);
    if (!batch || batch.status === "已完成" || batch.status === "应用中") return;
    batch.status = "应用中";
    batch.error = undefined;
    if (!batch.snapshot) {
      batch.snapshot = clone({ households: households.value, tasks: tasks.value, queue: queue.value, conflicts: conflicts.value });
    }
    try {
      batch.ops.forEach((op, index) => {
        if (batch.appliedOpIds.includes(op.id)) return; // 已接收字段不重复写入
        if (batch.interruptAt === index && !interrupted.has(batch.id)) {
          interrupted.add(batch.id);
          throw new Error("合并中断：平板连接断开，已接收字段保留，可续作重试");
        }
        applyOp(op);
        batch.appliedOpIds.push(op.id);
      });
      batch.status = "已完成";
      lastSyncedAt.value = new Date().toISOString();
      queue.value = [];
    } catch (error) {
      batch.status = "失败";
      batch.error = error instanceof Error ? error.message : String(error);
    }
  }

  // 恢复原包：回滚到合并批执行前的状态，数据包可整体重试
  function restoreBatch(id: string) {
    const batch = batches.value.find((item) => item.id === id);
    if (!batch || !batch.snapshot) return;
    households.value = clone(batch.snapshot.households);
    tasks.value = clone(batch.snapshot.tasks);
    queue.value = clone(batch.snapshot.queue);
    conflicts.value = clone(batch.snapshot.conflicts);
    batch.snapshot = null;
    batch.appliedOpIds = [];
    batch.error = undefined;
    batch.status = "待处理";
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") {
      (household as unknown as Record<string, unknown>)[conflict.field] = clone(conflict.remoteRaw ?? conflict.remoteValue);
    }
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
    }
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, batches, aliases, lastSyncedAt], () => {
      localStorage.setItem(KEY, JSON.stringify({ households: households.value, tasks: tasks.value, queue: queue.value, conflicts: conflicts.value, batches: batches.value, aliases: aliases.value, lastSyncedAt: lastSyncedAt.value }));
    }, { deep: true });
  }

  return { households, tasks, queue, conflicts, batches, aliases, online, lastSyncedAt, syncing, metrics, duplicates, pendingBatches, hasPendingConflicts, addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask, receivePackage, applyBatch, restoreBatch, resolveConflict, enqueue };
});
