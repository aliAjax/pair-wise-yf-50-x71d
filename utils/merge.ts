import type { Household, FieldTask, PendingChange, TaskStatus, NeedLevel } from "~/stores/assessment";

/** 字段来源裁定：local 本机 / remote 远端 / both 两个来源都保留 / null 未裁定 */
export type MergeAdopt = "local" | "remote" | "both" | null;

/** 单个字段的对齐结果 */
export interface MergeFieldDecision {
  field: keyof Household;
  label: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  /** 两边是否都相对基线改过且不一致 */
  bothChanged: boolean;
  adopt: MergeAdopt;
  /** 该字段是否已落盘（重试幂等依据） */
  received: boolean;
}

/** 任务转移：从消失的户改挂到保留户，状态不倒退 */
export interface TaskTransfer {
  taskId: string;
  fromHouseholdId: string;
  toHouseholdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  due: string;
  remoteStatus: TaskStatus;
  mergedStatus: TaskStatus;
  /** 本地已有同 id 任务，走状态合并 */
  duplicated: boolean;
}

/** 待同步操作随任务一起转移 */
export interface QueueTransfer {
  queueId: string;
  fromHouseholdId: string;
  toHouseholdId: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

/** 一条回站记录的对齐结果 */
export interface MergeAlignment {
  id: string;
  /** head + community 对齐键 */
  key: string;
  localId: string | null;
  remoteId: string;
  head: string;
  /** 本地无此记录（远端新增） */
  isNew: boolean;
  /** 同键不同 id：重复登记，走需求并集而非字段覆盖 */
  duplicate: boolean;
  fields: MergeFieldDecision[];
  taskTransfers: TaskTransfer[];
  queueTransfers: QueueTransfer[];
  /** 合并后保留的本地记录 id */
  retainedId: string | null;
}

export type MergeBatchStatus = "进行中" | "已定案" | "失败";

/** 续作合并批：原始包体保留，失败可据此重试 */
export interface MergeBatch {
  id: string;
  status: MergeBatchStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** 原始回站包：失败恢复与重试的依据 */
  pkg: {
    households: Household[];
    tasks: FieldTask[];
    queue: PendingChange[];
  };
  alignments: MergeAlignment[];
  /** 已落盘字段/任务/操作键，重试时不重复写入 */
  receivedKeys: string[];
}

export function alignmentKey(h: Pick<Household, "head" | "community">): string {
  return `${h.head}__${h.community}`;
}

export const MERGE_FIELDS: (keyof Household)[] = [
  "head", "community", "address", "members", "vulnerable", "needLevel", "needs", "status", "note",
];

export const FIELD_LABELS: Partial<Record<keyof Household, string>> = {
  head: "户主姓名",
  community: "社区",
  address: "地址",
  members: "家庭人数",
  vulnerable: "脆弱人群",
  needLevel: "需求等级",
  needs: "需求",
  status: "家庭状态",
  note: "现场说明",
};

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 字段级对齐：以基线判断两边是否都改过。
 * 两边都改过且不一致 → 留两个来源值（bothChanged，adopt 置空待裁定），不静默覆盖。
 */
export function alignField(
  field: keyof Household,
  base: Household | null,
  local: Household | null,
  remote: Household,
): MergeFieldDecision {
  const b = base ? base[field] : undefined;
  const l = local ? local[field] : undefined;
  const r = remote[field];
  const localChanged = !deepEqual(l, b);
  const remoteChanged = !deepEqual(r, b);
  const bothChanged = localChanged && remoteChanged && !deepEqual(l, r);
  let adopt: MergeAdopt = null;
  if (!bothChanged) {
    if (deepEqual(l, r)) adopt = "local";
    else if (localChanged) adopt = "local";
    else if (remoteChanged) adopt = "remote";
    else adopt = "local";
  }
  return {
    field,
    label: FIELD_LABELS[field] ?? field,
    baseValue: b,
    localValue: l,
    remoteValue: r,
    bothChanged,
    adopt,
    received: false,
  };
}

const TASK_RANK: Record<TaskStatus, number> = { 待接收: 0, 进行中: 1, 已完成: 2 };

/** 任务进度不倒退：取两边更靠前的状态 */
export function mergeTaskStatus(a: TaskStatus, b: TaskStatus): TaskStatus {
  return TASK_RANK[a] >= TASK_RANK[b] ? a : b;
}

/**
 * 回站记录按字段对齐。
 * - 同 id：字段级对齐，两边都改过留两个来源值
 * - 同键不同 id（重复登记）：标记 duplicate，走需求并集
 * - 本地无匹配：远端新增
 * 任务与待同步操作随保留记录转移。
 */
export function alignRecords(
  local: Household[],
  remote: Household[],
  base: Household[],
  remoteTasks: FieldTask[],
  remoteQueue: PendingChange[],
  localTasks: FieldTask[],
): MergeAlignment[] {
  const baseByKey = new Map<string, Household>();
  base.forEach((h) => baseByKey.set(alignmentKey(h), h));
  const baseById = new Map<string, Household>();
  base.forEach((h) => baseById.set(h.id, h));
  const localByKey = new Map<string, Household>();
  local.forEach((h) => localByKey.set(alignmentKey(h), h));
  const localById = new Map<string, Household>();
  local.forEach((h) => localById.set(h.id, h));

  const alignments: MergeAlignment[] = remote.map((r) => {
    const key = alignmentKey(r);
    const l = localById.get(r.id) ?? localByKey.get(key) ?? null;
    const b = baseById.get(r.id) ?? baseByKey.get(key) ?? null;
    const fields = MERGE_FIELDS.map((f) => alignField(f, b, l, r));
    const duplicate = !!l && r.id !== l.id;
    return {
      id: crypto.randomUUID(),
      key,
      localId: l?.id ?? null,
      remoteId: r.id,
      head: r.head,
      isNew: !l,
      duplicate,
      fields,
      taskTransfers: [],
      queueTransfers: [],
      retainedId: l ? l.id : r.id,
    };
  });

  const byRemoteId = new Map<string, MergeAlignment>();
  alignments.forEach((a) => byRemoteId.set(a.remoteId, a));

  // 任务转移：远端任务按其 householdId 对齐到保留记录
  remoteTasks.forEach((rt) => {
    const alignment = byRemoteId.get(rt.householdId);
    const toHouseholdId = alignment?.retainedId ?? rt.householdId;
    const existing = localTasks.find((t) => t.id === rt.id);
    alignment?.taskTransfers.push({
      taskId: rt.id,
      fromHouseholdId: rt.householdId,
      toHouseholdId,
      title: rt.title,
      assignee: rt.assignee,
      priority: rt.priority,
      due: rt.due,
      remoteStatus: rt.status,
      mergedStatus: existing ? mergeTaskStatus(existing.status, rt.status) : rt.status,
      duplicated: !!existing,
    });
  });

  // 待同步操作随任务一起转移到保留记录
  remoteQueue.forEach((q) => {
    if (!q.householdId) return;
    const alignment = byRemoteId.get(q.householdId);
    const toHouseholdId = alignment?.retainedId ?? q.householdId;
    alignment?.queueTransfers.push({
      queueId: q.id,
      fromHouseholdId: q.householdId,
      toHouseholdId,
      entity: q.entity,
      action: q.action,
      detail: q.detail,
      time: q.time,
    });
  });

  return alignments;
}

/**
 * 构造平板回站包：在本地记录基础上制造远端离线改动。
 * - h1：地址仅远端改；现场说明两边都改（留两个来源值）
 * - h2：远端推进了家庭状态（未定案前不推进）
 * - h3：平板侧仍保留重复登记（本地可能已合并消失）
 * - 新增一户；远端任务一条指向 h3、一条与本地 k1 同 id 且进度更靠前
 */
export function buildIncomingPackage(
  local: Household[],
  tasks: FieldTask[],
  queue: PendingChange[],
): { households: Household[]; tasks: FieldTask[]; queue: PendingChange[] } {
  const clone = (h: Household): Household => ({ ...h, vulnerable: [...h.vulnerable], needs: [...h.needs] });
  const remoteHouseholds: Household[] = local.map(clone);

  const h1 = remoteHouseholds.find((h) => h.id === "h1") ?? remoteHouseholds[0];
  if (h1) {
    h1.address = "河湾路18号2栋2单元";
    h1.note = "远端回站：一层受淹已安置，需慢病用药跟进";
    h1.deviceUpdatedAt = new Date().toISOString();
  }
  const h2 = remoteHouseholds.find((h) => h.id === "h2");
  if (h2) {
    h2.status = "已完成";
    h2.deviceUpdatedAt = new Date().toISOString();
  }
  if (!remoteHouseholds.some((h) => h.id === "h3")) {
    remoteHouseholds.push({
      id: "h3",
      head: "王建国",
      community: "河湾社区",
      address: "河湾路18号2幢2单元",
      members: 4,
      vulnerable: ["老人"],
      needLevel: "紧急",
      needs: ["临时安置", "慢病用药"],
      status: "待评估",
      version: 1,
      deviceUpdatedAt: new Date().toISOString(),
      note: "平板侧重复登记，未同步合并",
    });
  }
  remoteHouseholds.push({
    id: crypto.randomUUID(),
    head: "李华",
    community: "河湾社区",
    address: "河湾路12号",
    members: 3,
    vulnerable: ["儿童"],
    needLevel: "高",
    needs: ["临时安置"],
    status: "待评估",
    version: 1,
    deviceUpdatedAt: new Date().toISOString(),
    note: "远端新增登记",
  });

  const remoteTasks: FieldTask[] = [
    { id: "k-remote-1", householdId: "h3", title: "现场复核", assignee: "救援一组", priority: "紧急", status: "进行中", due: "2026-09-30 18:00" },
    { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "已完成", due: "2026-09-29 16:00" },
  ];
  const remoteQueue: PendingChange[] = [
    { id: crypto.randomUUID(), entity: "复核任务", action: "状态流转", detail: "h3 现场复核 → 进行中", time: new Date().toISOString(), householdId: "h3" },
  ];

  return { households: remoteHouseholds, tasks: remoteTasks, queue: remoteQueue };
}
