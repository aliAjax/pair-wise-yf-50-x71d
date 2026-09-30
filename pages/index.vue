<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { displayValue, useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
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
const panels = ["需求记录", "重复合并", "回站合并", "任务分派", "同步队列", "冲突处理"];

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
  store.receivePackage();
  syncMessage.value = "已接收回站数据包，请在「回站合并」中执行合并批，字段冲突不会自动覆盖。";
  panel.value = "回站合并";
}
function householdLabel(id: string) {
  return store.households.find((item) => item.id === id)?.head ?? `${id}（已合并）`;
}
function batchTagType(status: string) {
  return status === "已完成" ? "success" : status === "失败" ? "error" : status === "应用中" ? "info" : "default";
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in panels" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span><span v-if="item === '回站合并' && store.pendingBatches">({{ store.pendingBatches }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，回站后按合并批逐字段对齐，冲突保留两个来源值，人工定案。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更会写入IndexedDB兼容的本地缓存与待同步队列。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><NTag v-if="store.hasPendingConflicts(item.id)" size="small" type="warning">未定案</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">接收回站数据包</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><NAlert v-if="store.duplicates.length" type="info" show-icon>合并按字段对齐：两边都改过的字段保留两个来源值；复核任务与待同步操作一并转移到保留记录，任务进度不倒退，定案前家庭状态不推进。</NAlert><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">字段对齐合并，任务与队列转移到保留记录</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <NCard v-if="panel === '回站合并'" title="回站合并批（可续作）">
        <p>不同平板回传的数据包按字段对齐合并：同一字段两边都改过会保留两个来源值进入人工定案；合并批失败可续作重试，已接收字段不重复写入。</p>
        <div v-for="batch in store.batches" :key="batch.id" class="batch">
          <div class="batch-head"><b>{{ batch.label }}</b><NTag :type="batchTagType(batch.status)">{{ batch.status }}</NTag><span>{{ batch.appliedOpIds.length }}/{{ batch.ops.length }} 字段已接收</span></div>
          <NProgress type="line" :percentage="batch.ops.length ? Math.round(batch.appliedOpIds.length / batch.ops.length * 100) : 100" :status="batch.status === '失败' ? 'error' : batch.status === '已完成' ? 'success' : 'default'" />
          <NAlert v-if="batch.error" type="error" show-icon>{{ batch.error }}</NAlert>
          <div class="ops"><div v-for="op in batch.ops" :key="op.id" class="op-row"><NTag size="small" :type="batch.appliedOpIds.includes(op.id) ? 'success' : 'default'">{{ batch.appliedOpIds.includes(op.id) ? '已接收' : '待接收' }}</NTag><span>{{ householdLabel(op.householdId) }} · {{ op.field }} → {{ displayValue(op.remoteValue) }}</span><small>{{ op.deviceId }}</small></div></div>
          <div class="actions"><NButton v-if="batch.status === '待处理'" type="primary" size="small" @click="store.applyBatch(batch.id)">执行合并批</NButton><template v-if="batch.status === '失败'"><NButton type="primary" size="small" @click="store.applyBatch(batch.id)">续作重试（跳过已接收）</NButton><NButton size="small" :disabled="!batch.snapshot" @click="store.restoreBatch(batch.id)">恢复原包后重试</NButton></template><small v-if="batch.status === '已完成'">已于 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }} 完成合并</small></div>
        </div>
        <p v-if="!store.batches.length" class="empty">暂无回站数据包。点击“接收回站数据包”模拟另一台平板回传。</p>
        <NButton type="primary" :disabled="!store.online" @click="sync">接收回站数据包</NButton>
      </NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ householdLabel(task.householdId) }} · {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><NAlert v-if="selected && store.hasPendingConflicts(selected.id)" type="info" show-icon>该家庭存在未定案字段，定案前家庭状态不会推进。</NAlert><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按顺序提交，冲突不会自动覆盖。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><NButton type="primary" :loading="store.syncing" @click="sync">接收回站数据包</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突（人工定案）"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ householdLabel(item.householdId) }} · {{ item.field }}</b><small v-if="item.sourceDevice">来源：{{ item.sourceDevice }}</small><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>远端记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。执行回站合并批或重复合并后，两边都改过的字段会在这里保留两个来源值。</p></NCard>
    </main>
  </div>
</template>
