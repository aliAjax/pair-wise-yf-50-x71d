import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignField,
  alignRecords,
  mergeTaskStatus,
  buildIncomingPackage,
  alignmentKey,
  type MergeAlignment,
} from "../utils/merge";
import type { Household, FieldTask, PendingChange } from "../stores/assessment";

function h(over: Partial<Household> & { id: string }): Household {
  return {
    head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4,
    vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置"], status: "待复核",
    version: 1, deviceUpdatedAt: "2026-09-29T00:00:00.000Z", note: "基线说明", ...over,
  };
}

test("alignField: 两边都改且不一致 → 留两个来源值，不静默覆盖", () => {
  const base = h({ id: "h1", note: "基线说明" });
  const local = h({ id: "h1", note: "本机补充了老人情况" });
  const remote = h({ id: "h1", note: "远端改写了说明" });
  const d = alignField("note", base, local, remote);
  assert.equal(d.bothChanged, true);
  assert.equal(d.adopt, null);
  assert.equal(d.localValue, "本机补充了老人情况");
  assert.equal(d.remoteValue, "远端改写了说明");
});

test("alignField: 仅远端改 → 采用远端；仅本机改 → 采用本机", () => {
  const base = h({ id: "h1", address: "旧地址" });
  const local = h({ id: "h1", address: "旧地址" });
  const remote = h({ id: "h1", address: "新地址" });
  const d = alignField("address", base, local, remote);
  assert.equal(d.bothChanged, false);
  assert.equal(d.adopt, "remote");

  const d2 = alignField("address", base, h({ id: "h1", address: "本机地址" }), remote);
  assert.equal(d2.bothChanged, true);
});

test("alignField: 两边改成一致 → 不算冲突", () => {
  const base = h({ id: "h1", needLevel: "一般" });
  const local = h({ id: "h1", needLevel: "紧急" });
  const remote = h({ id: "h1", needLevel: "紧急" });
  const d = alignField("needLevel", base, local, remote);
  assert.equal(d.bothChanged, false);
});

test("mergeTaskStatus: 进度不倒退，取更靠前状态", () => {
  assert.equal(mergeTaskStatus("进行中", "已完成"), "已完成");
  assert.equal(mergeTaskStatus("已完成", "进行中"), "已完成");
  assert.equal(mergeTaskStatus("待接收", "进行中"), "进行中");
  assert.equal(mergeTaskStatus("待接收", "待接收"), "待接收");
});

test("alignRecords: 同 id 字段对齐 + 重复登记标记 + 新增户", () => {
  const local = [h({ id: "h1" }), h({ id: "h2", head: "赵敏", community: "新城社区", status: "已分派" })];
  const remote = [
    h({ id: "h1", note: "远端说明" }),
    h({ id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢" }),
    h({ id: "h-new", head: "李华", community: "河湾社区", address: "河湾路12号", status: "待评估" }),
  ];
  const base = [h({ id: "h1" }), h({ id: "h2", head: "赵敏", community: "新城社区", status: "已分派" })];
  const alignments = alignRecords(local, remote, base, [], [], []);
  const byId = new Map(alignments.map((a) => [a.remoteId, a]));
  assert.equal(byId.get("h1")?.duplicate, false);
  assert.equal(byId.get("h3")?.duplicate, true); // 同键不同 id
  assert.equal(byId.get("h3")?.retainedId, "h1"); // 保留记录是 h1
  assert.equal(byId.get("h-new")?.isNew, true);
  assert.equal(byId.get("h-new")?.retainedId, "h-new");
});

test("alignRecords: 任务转到保留记录，同 id 任务合并状态不倒退", () => {
  const local = [h({ id: "h1" })];
  const remote = [h({ id: "h3", head: "王建国", community: "河湾社区" })];
  const base = [h({ id: "h1" })];
  const localTasks: FieldTask[] = [
    { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤", priority: "一般", status: "进行中", due: "x" },
  ];
  const remoteTasks: FieldTask[] = [
    { id: "k-remote-1", householdId: "h3", title: "现场复核", assignee: "救援一组", priority: "紧急", status: "进行中", due: "x" },
    { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤", priority: "一般", status: "已完成", due: "x" },
  ];
  const alignments = alignRecords(local, remote, base, remoteTasks, [], localTasks);
  const h3 = alignments.find((a) => a.remoteId === "h3")!;
  assert.equal(h3.taskTransfers.length, 1);
  assert.equal(h3.taskTransfers[0].toHouseholdId, "h1");
  assert.equal(h3.taskTransfers[0].taskId, "k-remote-1");
  // k1 不在 h3 上（它指向 h2），单独验证非倒退
  assert.equal(mergeTaskStatus(localTasks[0].status, remoteTasks[1].status), "已完成");
});

test("alignRecords: 待同步操作随任务一起转移到保留记录", () => {
  const local = [h({ id: "h1" })];
  const remote = [h({ id: "h3", head: "王建国", community: "河湾社区" })];
  const base = [h({ id: "h1" })];
  const remoteQueue: PendingChange[] = [
    { id: "q1", entity: "复核任务", action: "状态流转", detail: "h3 → 进行中", time: "x", householdId: "h3" },
  ];
  const alignments = alignRecords(local, remote, base, [], remoteQueue, []);
  const h3 = alignments.find((a) => a.remoteId === "h3")!;
  assert.equal(h3.queueTransfers.length, 1);
  assert.equal(h3.queueTransfers[0].toHouseholdId, "h1");
});

test("buildIncomingPackage: 包含两边都改字段、重复登记、新增户与转移任务", () => {
  const local = [h({ id: "h1", note: "本机说明" }), h({ id: "h2", head: "赵敏", community: "新城社区", status: "已分派" })];
  const pkg = buildIncomingPackage(local, [], []);
  assert.ok(pkg.households.some((x) => x.id === "h1"));
  assert.ok(pkg.households.some((x) => x.id === "h3")); // 平板侧重复登记仍在
  assert.ok(pkg.households.some((x) => x.head === "李华")); // 新增户
  assert.ok(pkg.tasks.some((x) => x.householdId === "h3")); // 任务指向重复记录
  assert.ok(pkg.queue.some((x) => x.householdId === "h3"));
  // h1 说明被远端改写（两边都改的冲突来源）
  const h1 = pkg.households.find((x) => x.id === "h1")!;
  assert.notEqual(h1.note, "本机说明");
});

test("alignmentKey: 同 head+community 对齐", () => {
  assert.equal(alignmentKey(h({ id: "a" })), alignmentKey(h({ id: "b" })));
});
