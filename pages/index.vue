<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import type { MergeBatch } from "~/utils/merge";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.string().min(1, "请输入家庭人数"), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: "1", needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  syncMessage.value = "正在回站续作合并离线包…";
  store.createMergeBatch();
  panel.value = "回站合并";
  setTimeout(() => { syncMessage.value = "回站合并批已建立：无冲突字段已落盘，两边都改的字段留两个来源值，可在下方定案。"; }, 600);
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.join("、") || "（空）";
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v ?? "—");
}
function undecidedCount(batch: MergeBatch): number {
  return batch.alignments.reduce((n, a) => n + a.fields.filter((f) => f.bothChanged && f.adopt === null).length, 0);
}
function batchTagType(status: MergeBatch["status"]) {
  return status === "已定案" ? "success" : status === "失败" ? "error" : "warning";
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '回站合并', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span><span v-if="item === '回站合并' && store.mergeBatches.length">({{ store.mergeBatches.length }})</span><span v-if="item === '冲突处理' && store.pendingConflicts.length">({{ store.pendingConflicts.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，回站后按字段续作合并：两边都改留两个来源值，定案前不推进状态。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更会写入本地缓存与待同步队列；回站后按字段续作合并，不静默覆盖。</NAlert>

      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p><p v-if="item.fieldSources" class="sources">两来源值：<span v-for="(v, k) in item.fieldSources" :key="k">{{ k }}（{{ v.sources.map(s => s.source).join('/') }}）</span></p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">回站合并</NButton></div></form></NCard>
      </div>

      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条（任务与待同步操作转到保留记录）</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>

      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton></NCard></div>

      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按顺序提交，冲突不会自动覆盖。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small v-if="item.householdId">→ {{ item.householdId }}</small><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><NButton type="primary" :loading="store.syncing" @click="sync">回站合并离线包</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>

      <NCard v-if="panel === '回站合并'" title="回站续作合并批">
        <p>平板回站后按字段对齐：同字段两边都改过留两个来源值；状态在定案前不推进；复核任务转到保留记录且进度不倒退；任务与待同步操作一起转移。合并批失败后原包保留，可重试且已接收字段不重复写入。</p>
        <NButton type="primary" @click="store.createMergeBatch()">模拟回站并建立合并批</NButton>
        <div v-for="batch in store.mergeBatches" :key="batch.id" class="batch">
          <div class="batch-head">
            <b>{{ batch.source }}</b>
            <NTag :type="batchTagType(batch.status)">{{ batch.status }}</NTag>
            <small>{{ new Date(batch.updatedAt).toLocaleString('zh-CN') }}</small>
          </div>
          <NAlert v-if="batch.status === '失败'" type="error" class="batch-alert">
            {{ batch.error }}；原包已保留，可重试，已接收字段不会重复写入。
            <NButton size="small" type="primary" @click="store.retryBatch(batch.id)">重试合并批</NButton>
          </NAlert>
          <div v-for="a in batch.alignments" :key="a.id" class="alignment">
            <div class="align-head">
              <b>{{ a.head }}</b>
              <NTag size="small">{{ a.isNew ? '新增户' : a.duplicate ? '重复登记·需求并集' : '已对齐' }}</NTag>
              <small>保留记录 {{ a.retainedId }}</small>
            </div>
            <div v-for="f in a.fields.filter((x) => x.bothChanged)" :key="String(f.field)" class="field-decision">
              <span class="field-name">{{ f.label }}</span>
              <div class="vals">
                <div><small>本机</small><span>{{ fmt(f.localValue) }}</span></div>
                <div><small>远端</small><span>{{ fmt(f.remoteValue) }}</span></div>
              </div>
              <div class="actions">
                <NButton size="small" :disabled="batch.status === '已定案'" @click="store.adoptField(batch.id, a.id, f.field, 'local')">采用本机</NButton>
                <NButton size="small" type="primary" :disabled="batch.status === '已定案'" @click="store.adoptField(batch.id, a.id, f.field, 'remote')">采用远端</NButton>
                <NButton size="small" :disabled="batch.status === '已定案'" @click="store.adoptField(batch.id, a.id, f.field, 'both')">留两个来源值</NButton>
                <NTag v-if="f.adopt" size="small" :type="f.adopt === 'both' ? 'warning' : 'success'">已裁定·{{ f.adopt === 'both' ? '两来源' : f.adopt === 'local' ? '本机' : '远端' }}</NTag>
              </div>
            </div>
            <div v-for="tt in a.taskTransfers" :key="tt.taskId" class="transfer">
              <NTag size="small" type="info">任务转移</NTag>
              <span>{{ tt.title }}：{{ tt.fromHouseholdId }} → {{ tt.toHouseholdId }}</span>
              <NTag size="small" :type="tt.mergedStatus === '已完成' ? 'success' : 'warning'">{{ tt.mergedStatus }}</NTag>
              <NTag v-if="tt.duplicated" size="small" type="warning">同任务合并·进度不倒退</NTag>
            </div>
            <div v-for="qt in a.queueTransfers" :key="qt.queueId" class="transfer">
              <NTag size="small" type="info">待同步转移</NTag>
              <span>{{ qt.entity }}·{{ qt.action }}：{{ qt.fromHouseholdId }} → {{ qt.toHouseholdId }}</span>
            </div>
          </div>
          <div class="batch-foot">
            <small>已接收 {{ batch.receivedKeys.length }} 项 · 待裁定 {{ undecidedCount(batch) }} 项</small>
            <NButton size="small" type="primary" :disabled="batch.status === '已定案' || batch.status === '失败' || undecidedCount(batch) > 0" @click="store.finalizeBatch(batch.id)">定案</NButton>
          </div>
        </div>
        <p v-if="!store.mergeBatches.length" class="empty">暂无回站合并批。</p>
      </NCard>

      <NCard v-if="panel === '冲突处理'" title="字段级冲突（两边都改·留两个来源值）">
        <div v-for="item in store.pendingConflicts" :key="item.batchId + item.alignmentId + String(item.field)" class="conflict">
          <b>{{ item.head }} · {{ item.label }}</b>
          <NTag size="small">{{ item.batchSource }} · {{ item.batchStatus }}</NTag>
          <div class="conflict-values">
            <div><small>本机记录</small><span>{{ fmt(item.localValue) }}</span></div>
            <div><small>远端记录</small><span>{{ fmt(item.remoteValue) }}</span></div>
          </div>
          <div class="actions">
            <NButton size="small" @click="store.adoptField(item.batchId, item.alignmentId, item.field, 'local')">采用本机</NButton>
            <NButton size="small" type="primary" @click="store.adoptField(item.batchId, item.alignmentId, item.field, 'remote')">采用远端</NButton>
            <NButton size="small" @click="store.adoptField(item.batchId, item.alignmentId, item.field, 'both')">留两个来源值</NButton>
          </div>
        </div>
        <p v-if="!store.pendingConflicts.length" class="empty">暂无两边都改的字段冲突。可先到「回站合并」建立合并批。</p>
      </NCard>
    </main>
  </div>
</template>
