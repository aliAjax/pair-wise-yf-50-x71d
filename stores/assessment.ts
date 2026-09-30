import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  alignRecords,
  buildIncomingPackage,
  mergeTaskStatus,
  type MergeBatch,
  type MergeAdopt,
  type MergeFieldDecision,
} from "~/utils/merge";

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
  /** 两边都改过时保留的两个来源值 */
  fieldSources?: Record<string, { sources: { source: string; value: unknown }[] }>;
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

const KEY = "pair-wise-yf-50/assessment";
const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

function cloneHouseholds(list: Household[]): Household[] {
  return list.map((h) => ({ ...h, vulnerable: [...h.vulnerable], needs: [...h.needs] }));
}

/** 上次同步基线：h1 说明较短，回站时本地已补充、远端也改写 → 两边都改 */
function seedBase(): Household[] {
  const base = cloneHouseholds(seedHouseholds);
  const h1 = base.find((h) => h.id === "h1");
  if (h1) h1.note = "一层受淹";
  return base;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? cloneHouseholds(seedHouseholds));
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const baseHouseholds = ref<Household[]>(initial?.baseHouseholds ?? seedBase());
  const mergeBatches = ref<MergeBatch[]>(initial?.mergeBatches ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);

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

  /** 待裁定字段：来自进行中/失败的合并批，两边都改且未裁定 */
  const pendingConflicts = computed(() => {
    const out: { batchId: string; batchSource: string; alignmentId: string; head: string; field: keyof Household; label: string; localValue: unknown; remoteValue: unknown; batchStatus: string }[] = [];
    mergeBatches.value.forEach((b) => {
      if (b.status === "已定案") return;
      b.alignments.forEach((a) => {
        if (a.duplicate) return;
        a.fields.forEach((f) => {
          if (f.bothChanged && f.adopt === null) {
            out.push({
              batchId: b.id, batchSource: b.source, alignmentId: a.id, head: a.head,
              field: f.field, label: f.label, localValue: f.localValue, remoteValue: f.remoteValue, batchStatus: b.status,
            });
          }
        });
      });
    });
    return out;
  });

  function enqueue(entity: string, action: string, detail: string, householdId?: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: new Date().toISOString(), householdId });
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

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    // 任务转移到保留记录：同 id 合并状态（进度不倒退），其余改挂保留户
    const orphanTasks: string[] = [];
    tasks.value.forEach((t) => {
      if (t.householdId !== sourceId) return;
      const twin = tasks.value.find((x) => x.id === t.id && x.householdId === targetId);
      if (twin) {
        twin.status = mergeTaskStatus(twin.status, t.status);
        orphanTasks.push(t.id);
      } else {
        t.householdId = targetId;
      }
    });
    tasks.value = tasks.value.filter((t) => !orphanTasks.includes(t.id));
    // 待同步操作随任务一起转移
    queue.value.forEach((q) => { if (q.householdId === sourceId) q.householdId = targetId; });
    households.value = households.value.filter((item) => item.id !== sourceId);
    enqueue("重复记录", "合并", `${source.head} → ${target.address}`, targetId);
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    tasks.value.unshift({ ...input, id: crypto.randomUUID(), status: "待接收" });
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`, input.householdId);
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`, task.householdId);
  }

  // ---- 回站续作合并批 ----

  function createMergeBatch(source = "平板离线包") {
    const pkg = buildIncomingPackage(households.value, tasks.value, queue.value);
    const alignments = alignRecords(households.value, pkg.households, baseHouseholds.value, pkg.tasks, pkg.queue, tasks.value);
    const batch: MergeBatch = {
      id: crypto.randomUUID(),
      status: "进行中",
      source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pkg,
      alignments,
      receivedKeys: [],
    };
    mergeBatches.value.unshift(batch);
    persist();
    // 回站即续作合并：先落无冲突字段，状态未定案前不推进
    applyBatch(batch, { finalize: false, failAfter: 3 });
    return batch;
  }

  function retryBatch(id: string) {
    const batch = mergeBatches.value.find((b) => b.id === id);
    if (!batch || batch.status !== "失败") return;
    batch.status = "进行中";
    batch.error = undefined;
    applyBatch(batch, { finalize: false });
  }

  function finalizeBatch(id: string) {
    const batch = mergeBatches.value.find((b) => b.id === id);
    if (!batch || batch.status === "已定案") return;
    applyBatch(batch, { finalize: true });
  }

  function adoptField(batchId: string, alignmentId: string, field: keyof Household, adopt: MergeAdopt) {
    const batch = mergeBatches.value.find((b) => b.id === batchId);
    if (!batch) return;
    const alignment = batch.alignments.find((a) => a.id === alignmentId);
    if (!alignment) return;
    const decision = alignment.fields.find((f) => f.field === field);
    if (!decision) return;
    decision.adopt = adopt;
    batch.updatedAt = new Date().toISOString();
    persist();
  }

  function applyBatch(batch: MergeBatch, opts: { finalize: boolean; failAfter?: number }): { applied: number; failed: boolean } {
    let applied = 0;
    try {
      for (const alignment of batch.alignments) {
        // 远端新增户：先建户，后续任务才能挂到保留记录
        if (alignment.isNew && !households.value.some((h) => h.id === alignment.retainedId)) {
          const remote = batch.pkg.households.find((h) => h.id === alignment.remoteId);
          if (remote) households.value.push({ ...cloneHouseholds([remote])[0], fieldSources: undefined });
        }

        if (alignment.duplicate) {
          // 重复登记：需求/脆弱人群取并集、说明追加，不改写身份字段
          const dkey = `${alignment.id}:duplicate`;
          if (batch.receivedKeys.includes(dkey)) continue; // 已接收不重复写
          const target = households.value.find((h) => h.id === alignment.retainedId);
          const remote = batch.pkg.households.find((h) => h.id === alignment.remoteId);
          if (target && remote) {
            target.needs = Array.from(new Set([...target.needs, ...remote.needs]));
            target.vulnerable = Array.from(new Set([...target.vulnerable, ...remote.vulnerable]));
            if (remote.note && !target.note.includes(remote.note)) target.note = `${target.note}；${remote.note}`;
          }
          batch.receivedKeys.push(dkey);
        } else {
          for (const decision of alignment.fields) {
            const key = `${alignment.id}:${String(decision.field)}`;
            if (batch.receivedKeys.includes(key)) continue; // 已接收字段不重复写入
            if (decision.bothChanged && decision.adopt === null) continue; // 两边都改未裁定，留两个来源值
            if (decision.field === "status" && !opts.finalize) continue; // 未定案前不推进家庭状态
            writeDecision(alignment, decision);
            batch.receivedKeys.push(key);
            decision.received = true;
            applied += 1;
            if (opts.failAfter && applied >= opts.failAfter) {
              throw new Error("回站包写入中断：部分字段未落盘，原包已保留，可重试");
            }
          }
        }

        // 任务转移到保留记录，进度不倒退
        for (const tt of alignment.taskTransfers) {
          const tkey = `${alignment.id}:task:${tt.taskId}`;
          if (batch.receivedKeys.includes(tkey)) continue; // 已接收不重复写
          const existing = tasks.value.find((t) => t.id === tt.taskId);
          if (existing) {
            existing.status = mergeTaskStatus(existing.status, tt.mergedStatus);
            existing.householdId = tt.toHouseholdId;
          } else {
            tasks.value.push({ id: tt.taskId, householdId: tt.toHouseholdId, title: tt.title, assignee: tt.assignee, priority: tt.priority, due: tt.due, status: tt.mergedStatus });
          }
          batch.receivedKeys.push(tkey);
        }

        // 待同步操作随任务一起转移
        for (const qt of alignment.queueTransfers) {
          const qkey = `${alignment.id}:queue:${qt.queueId}`;
          if (batch.receivedKeys.includes(qkey)) continue; // 已接收不重复写
          if (!queue.value.some((q) => q.id === qt.queueId)) {
            queue.value.push({ id: qt.queueId, entity: qt.entity, action: qt.action, detail: qt.detail, time: qt.time, householdId: qt.toHouseholdId });
          }
          batch.receivedKeys.push(qkey);
        }
      }

      if (opts.finalize) {
        batch.status = "已定案";
        baseHouseholds.value = cloneHouseholds(households.value);
        lastSyncedAt.value = new Date().toISOString();
      }
      batch.updatedAt = new Date().toISOString();
      persist();
      return { applied, failed: false };
    } catch (e) {
      batch.status = "失败";
      batch.error = (e as Error).message;
      batch.updatedAt = new Date().toISOString();
      persist();
      return { applied, failed: true };
    }
  }

  function writeDecision(alignment: MergeAlignment, decision: MergeFieldDecision) {
    const target = households.value.find((h) => h.id === alignment.retainedId);
    if (!target) return;
    if (decision.bothChanged && decision.adopt === "both") {
      target.fieldSources = {
        ...(target.fieldSources ?? {}),
        [decision.field]: {
          sources: [
            { source: "本机", value: decision.localValue },
            { source: "远端", value: decision.remoteValue },
          ],
        },
      };
      (target as Record<string, unknown>)[decision.field] = decision.localValue;
    } else {
      const v = decision.adopt === "remote" ? decision.remoteValue : decision.localValue;
      (target as Record<string, unknown>)[decision.field] = v;
    }
    target.version += 1;
    target.deviceUpdatedAt = new Date().toISOString();
  }

  function persist() {
    if (typeof window === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify({
      households: households.value,
      tasks: tasks.value,
      queue: queue.value,
      baseHouseholds: baseHouseholds.value,
      mergeBatches: mergeBatches.value,
      lastSyncedAt: lastSyncedAt.value,
    }));
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, baseHouseholds, mergeBatches, lastSyncedAt], persist, { deep: true });
  }

  return {
    households, tasks, queue, baseHouseholds, mergeBatches, online, lastSyncedAt, syncing,
    metrics, duplicates, pendingConflicts,
    addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask,
    createMergeBatch, retryBatch, finalizeBatch, adoptField, enqueue,
  };
});
