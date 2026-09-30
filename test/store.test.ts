import { test } from "node:test";
import assert from "node:assert/strict";
import { setActivePinia, createPinia } from "pinia";
import { useAssessmentStore } from "../stores/assessment";

function freshStore() {
  setActivePinia(createPinia());
  return useAssessmentStore();
}

test("回站合并批：失败后原包保留、可重试，已接收字段不重复写", () => {
  const store = freshStore();
  // 先在本地把重复登记 h3 合并掉（h3 消失），再回站
  store.mergeDuplicate("h3", "h1");
  assert.equal(store.mergeBatches.length, 0);

  const batch = store.createMergeBatch();
  // failAfter=3：落了 head/community/address 后中断
  assert.equal(batch.status, "失败");
  assert.ok(batch.error);
  // 原包完整保留
  assert.ok(batch.pkg.households.some((x) => x.id === "h1"));
  assert.ok(batch.pkg.households.some((x) => x.id === "h3"));
  assert.ok(batch.pkg.households.some((x) => x.head === "李华"));
  // 已接收 3 项，address 已落盘
  assert.equal(batch.receivedKeys.length, 3);
  const h1 = store.households.find((x) => x.id === "h1")!;
  assert.equal(h1.address, "河湾路18号2栋2单元");
  // 两边都改的 note 未裁定 → 未落盘（远端值不静默覆盖）
  assert.ok(!h1.note.includes("远端回站"));
  // 未定案前不推进家庭状态
  const h2 = store.households.find((x) => x.id === "h2")!;
  assert.equal(h2.status, "已分派");

  const before = batch.receivedKeys.length;
  store.retryBatch(batch.id);
  assert.equal(batch.status, "进行中");
  // 重试后接收项增加，且无重复键
  assert.ok(batch.receivedKeys.length > before);
  assert.equal(new Set(batch.receivedKeys).size, batch.receivedKeys.length);
});

test("回站合并批：复核任务转到保留记录，进度不倒退；待同步操作一起转移", () => {
  const store = freshStore();
  store.mergeDuplicate("h3", "h1");
  const batch = store.createMergeBatch();
  store.retryBatch(batch.id);

  // 指向 h3（本地已合并消失）的任务改挂保留记录 h1
  const remoteReview = store.tasks.find((t) => t.id === "k-remote-1");
  assert.ok(remoteReview);
  assert.equal(remoteReview!.householdId, "h1");
  // 同 id 任务 k1 进度不倒退：本地进行中 + 远端已完成 → 已完成
  const k1 = store.tasks.find((t) => t.id === "k1")!;
  assert.equal(k1.status, "已完成");
  // 待同步操作随任务转移到 h1
  const transferred = store.queue.filter((q) => q.householdId === "h1");
  assert.ok(transferred.length >= 1);
  assert.ok(transferred.some((q) => q.entity === "复核任务"));
});

test("回站合并批：定案后才推进状态；两边都改可留两个来源值", () => {
  const store = freshStore();
  store.mergeDuplicate("h3", "h1");
  const batch = store.createMergeBatch();
  store.retryBatch(batch.id);

  // 定案前 h2 状态不推进
  let h2 = store.households.find((x) => x.id === "h2")!;
  assert.equal(h2.status, "已分派");

  // 裁定 h1 note：留两个来源值
  const alignment = batch.alignments.find((a) => a.remoteId === "h1")!;
  store.adoptField(batch.id, alignment.id, "note", "both");
  store.finalizeBatch(batch.id);
  assert.equal(batch.status, "已定案");

  const h1 = store.households.find((x) => x.id === "h1")!;
  // 留两个来源值：本机值为当前值（含本地合并标记），远端值不静默覆盖
  assert.ok(!h1.note.includes("远端回站"));
  assert.ok(h1.note.includes("一层受淹"));
  assert.ok(h1.fieldSources?.note);
  const sources = h1.fieldSources!.note.sources.map((s) => s.source);
  assert.ok(sources.includes("本机") && sources.includes("远端"));
  // 定案后 h2 状态推进
  h2 = store.households.find((x) => x.id === "h2")!;
  assert.equal(h2.status, "已完成");
  // 基线更新为合并结果
  assert.equal(store.baseHouseholds.find((x) => x.id === "h2")!.status, "已完成");
});

test("回站合并批：采用远端裁定后写入远端值", () => {
  const store = freshStore();
  store.mergeDuplicate("h3", "h1");
  const batch = store.createMergeBatch();
  store.retryBatch(batch.id);
  const alignment = batch.alignments.find((a) => a.remoteId === "h1")!;
  store.adoptField(batch.id, alignment.id, "note", "remote");
  store.finalizeBatch(batch.id);
  const h1 = store.households.find((x) => x.id === "h1")!;
  assert.equal(h1.note, "远端回站：一层受淹已安置，需慢病用药跟进");
});

test("本地重复合并：任务与待同步操作转到保留记录", () => {
  const store = freshStore();
  // 先给 h3 加任务与待同步操作
  store.addTask({ householdId: "h3", title: "现场复核", assignee: "救援一组", priority: "紧急", due: "x" });
  const h3Task = store.tasks.find((t) => t.householdId === "h3")!;
  assert.ok(h3Task);
  // 合并 h3 → h1
  store.mergeDuplicate("h3", "h1");
  assert.equal(store.households.find((x) => x.id === "h3"), undefined);
  // 任务改挂 h1
  const moved = store.tasks.find((t) => t.id === h3Task.id)!;
  assert.equal(moved.householdId, "h1");
  // 待同步操作转移
  assert.ok(store.queue.some((q) => q.householdId === "h1" && q.entity === "任务"));
});
