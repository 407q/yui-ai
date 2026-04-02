<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import {
  deleteMemory,
  fetchHealth,
  fetchMemoryDetail,
  fetchMemoryList,
  fetchNamespaces,
  upsertMemory,
} from "./api";
import type {
  MemoryEntryDetailResponse,
  MemoryEntrySummary,
  MemoryNamespaceSummary,
  MemoryUpsertRequest,
} from "./types";

const loading = ref(false);
const saving = ref(false);
const deleting = ref(false);
const errorMessage = ref<string | null>(null);
const infoMessage = ref<string | null>(null);

const health = ref<{ status: string; database: string } | null>(null);
const namespaces = ref<MemoryNamespaceSummary[]>([]);
const entries = ref<MemoryEntrySummary[]>([]);
const total = ref(0);
const selectedMemoryId = ref<string | null>(null);
const detail = ref<MemoryEntryDetailResponse | null>(null);

const query = reactive({
  search: "",
  namespace: "",
  userId: "",
  includeSystem: true,
  limit: 200,
});

const editor = reactive({
  user_id: "",
  namespace: "",
  key: "",
  value_json_text: "{\n  \"content\": \"\"\n}",
  tags_text: "",
  is_system: false,
});

const selectedEntry = computed<MemoryEntrySummary | null>(() => {
  if (!selectedMemoryId.value) {
    return null;
  }
  return entries.value.find((entry) => entry.memory_id === selectedMemoryId.value) ?? null;
});

const prettyValue = computed(() => {
  if (!selectedEntry.value) {
    return "";
  }
  return JSON.stringify(selectedEntry.value.value_json, null, 2);
});

onMounted(async () => {
  await refreshAll();
});

async function refreshAll(): Promise<void> {
  await Promise.all([loadHealth(), loadNamespaces(), loadEntries()]);
  if (selectedMemoryId.value) {
    await loadDetail(selectedMemoryId.value);
  }
}

async function loadHealth(): Promise<void> {
  health.value = await fetchHealth();
}

async function loadNamespaces(): Promise<void> {
  const response = await fetchNamespaces();
  namespaces.value = response.namespaces;
}

async function loadEntries(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    const response = await fetchMemoryList({
      search: query.search,
      namespace: query.namespace,
      userId: query.userId,
      includeSystem: query.includeSystem,
      limit: query.limit,
      offset: 0,
    });
    entries.value = response.entries;
    total.value = response.total;
    if (
      selectedMemoryId.value &&
      !entries.value.some((entry) => entry.memory_id === selectedMemoryId.value)
    ) {
      selectedMemoryId.value = null;
      detail.value = null;
    }
  } catch (error) {
    errorMessage.value = toErrorMessage(error);
  } finally {
    loading.value = false;
  }
}

async function selectEntry(memoryId: string): Promise<void> {
  selectedMemoryId.value = memoryId;
  await loadDetail(memoryId);
}

async function loadDetail(memoryId: string): Promise<void> {
  try {
    detail.value = await fetchMemoryDetail(memoryId);
  } catch (error) {
    errorMessage.value = toErrorMessage(error);
  }
}

function fillEditorFromSelected(): void {
  if (!selectedEntry.value) {
    return;
  }
  editor.user_id = selectedEntry.value.user_id;
  editor.namespace = selectedEntry.value.namespace;
  editor.key = selectedEntry.value.key;
  editor.value_json_text = JSON.stringify(selectedEntry.value.value_json, null, 2);
  editor.tags_text = selectedEntry.value.tags_json.join(", ");
  editor.is_system = selectedEntry.value.is_system;
  infoMessage.value = "選択中エントリを編集フォームへ反映しました。";
}

function resetEditor(): void {
  editor.user_id = "";
  editor.namespace = "";
  editor.key = "";
  editor.value_json_text = "{\n  \"content\": \"\"\n}";
  editor.tags_text = "";
  editor.is_system = false;
}

async function submitUpsert(): Promise<void> {
  saving.value = true;
  errorMessage.value = null;
  infoMessage.value = null;
  try {
    const payload = buildUpsertPayload();
    const response = await upsertMemory(payload);
    infoMessage.value = `保存しました: ${response.entry.namespace}/${response.entry.key}`;
    await Promise.all([loadNamespaces(), loadEntries()]);
    selectedMemoryId.value = response.entry.memory_id;
    await loadDetail(response.entry.memory_id);
  } catch (error) {
    errorMessage.value = toErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function removeSelected(force: boolean): Promise<void> {
  if (!selectedEntry.value) {
    return;
  }
  deleting.value = true;
  errorMessage.value = null;
  infoMessage.value = null;
  try {
    await deleteMemory(selectedEntry.value.memory_id, force);
    infoMessage.value = `削除しました: ${selectedEntry.value.namespace}/${selectedEntry.value.key}`;
    selectedMemoryId.value = null;
    detail.value = null;
    await Promise.all([loadNamespaces(), loadEntries()]);
  } catch (error) {
    errorMessage.value = toErrorMessage(error);
  } finally {
    deleting.value = false;
  }
}

function buildUpsertPayload(): MemoryUpsertRequest {
  const parsed = parseJsonOrThrow(editor.value_json_text, "value_json");
  return {
    user_id: requireNonEmpty(editor.user_id, "user_id"),
    namespace: requireNonEmpty(editor.namespace, "namespace"),
    key: requireNonEmpty(editor.key, "key"),
    value_json: parsed,
    tags_json: editor.tags_text
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    is_system: editor.is_system,
  };
}

function parseJsonOrThrow(input: string, field: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new Error(`${field} は JSON 形式で入力してください。`);
  }
}

function requireNonEmpty(input: string, field: string): string {
  const normalized = input.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} は必須です。`);
  }
  return normalized;
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900">
    <header class="border-b border-slate-200 bg-white">
      <div class="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4">
        <div>
          <h1 class="text-xl font-semibold">Memory Tool</h1>
          <p class="text-sm text-slate-500">
            DB上の memory_entries を一覧表示・詳細確認・更新・削除
          </p>
        </div>
        <div class="text-right text-xs text-slate-500">
          <div>API: {{ health?.status ?? "..." }}</div>
          <div>DB: {{ health?.database ?? "..." }}</div>
        </div>
      </div>
    </header>

    <main class="mx-auto grid max-w-[1500px] grid-cols-12 gap-4 px-5 py-4">
      <section class="col-span-12 rounded-lg border border-slate-200 bg-white p-4 lg:col-span-3">
        <h2 class="mb-3 text-sm font-semibold text-slate-700">フィルタ</h2>
        <div class="space-y-3">
          <label class="block text-xs font-medium text-slate-600">
            Search
            <input
              v-model="query.search"
              type="text"
              class="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="key / value / tag / user"
            />
          </label>
          <label class="block text-xs font-medium text-slate-600">
            Namespace
            <select
              v-model="query.namespace"
              class="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">(all)</option>
              <option
                v-for="item in namespaces"
                :key="item.namespace"
                :value="item.namespace"
              >
                {{ item.namespace }} ({{ item.count }})
              </option>
            </select>
          </label>
          <label class="block text-xs font-medium text-slate-600">
            User ID
            <input
              v-model="query.userId"
              type="text"
              class="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="e.g. user_xxx"
            />
          </label>
          <label class="flex items-center gap-2 text-xs text-slate-700">
            <input v-model="query.includeSystem" type="checkbox" />
            Include system memory
          </label>
          <button
            class="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
            :disabled="loading"
            @click="loadEntries"
          >
            {{ loading ? "Loading..." : "検索" }}
          </button>
          <button
            class="w-full rounded border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100"
            @click="refreshAll"
          >
            全体更新
          </button>
        </div>
      </section>

      <section class="col-span-12 rounded-lg border border-slate-200 bg-white p-4 lg:col-span-5">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-slate-700">一覧</h2>
          <span class="text-xs text-slate-500">{{ total }} entries</span>
        </div>
        <div class="max-h-[68vh] overflow-auto rounded border border-slate-200">
          <table class="w-full border-collapse text-left text-xs">
            <thead class="sticky top-0 bg-slate-50 text-slate-600">
              <tr>
                <th class="border-b border-slate-200 px-2 py-2">namespace/key</th>
                <th class="border-b border-slate-200 px-2 py-2">user</th>
                <th class="border-b border-slate-200 px-2 py-2">links</th>
                <th class="border-b border-slate-200 px-2 py-2">updated</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in entries"
                :key="entry.memory_id"
                class="cursor-pointer hover:bg-slate-50"
                :class="{ 'bg-blue-50': selectedMemoryId === entry.memory_id }"
                @click="selectEntry(entry.memory_id)"
              >
                <td class="border-b border-slate-100 px-2 py-2">
                  <div class="font-medium">{{ entry.namespace }}</div>
                  <div class="font-mono text-[11px] text-slate-500">{{ entry.key }}</div>
                  <div v-if="entry.is_system" class="mt-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                    system
                  </div>
                </td>
                <td class="border-b border-slate-100 px-2 py-2 font-mono text-[11px]">
                  {{ entry.user_id }}
                </td>
                <td class="border-b border-slate-100 px-2 py-2">
                  <span class="font-mono">in {{ entry.inbound_links }} / out {{ entry.outbound_links }}</span>
                </td>
                <td class="border-b border-slate-100 px-2 py-2">{{ formatDate(entry.updated_at) }}</td>
              </tr>
              <tr v-if="entries.length === 0">
                <td class="px-2 py-6 text-center text-slate-500" colspan="4">
                  該当データがありません
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="col-span-12 rounded-lg border border-slate-200 bg-white p-4 lg:col-span-4">
        <h2 class="mb-3 text-sm font-semibold text-slate-700">詳細 / 編集</h2>
        <div v-if="selectedEntry" class="mb-3 space-y-1 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
          <div><span class="font-medium">memory_id:</span> <span class="font-mono">{{ selectedEntry.memory_id }}</span></div>
          <div><span class="font-medium">namespace:</span> {{ selectedEntry.namespace }}</div>
          <div><span class="font-medium">key:</span> <span class="font-mono">{{ selectedEntry.key }}</span></div>
          <div><span class="font-medium">updated:</span> {{ formatDate(selectedEntry.updated_at) }}</div>
          <pre class="mt-2 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">{{ prettyValue }}</pre>
          <div class="flex gap-2">
            <button class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-white" @click="fillEditorFromSelected">
              編集へ反映
            </button>
            <button
              class="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-60"
              :disabled="deleting"
              @click="removeSelected(false)"
            >
              削除
            </button>
            <button
              class="rounded border border-red-500 px-2 py-1 text-xs text-red-700 hover:bg-red-100 disabled:opacity-60"
              :disabled="deleting"
              @click="removeSelected(true)"
            >
              強制削除
            </button>
          </div>
        </div>

        <div v-if="detail" class="mb-3 grid grid-cols-2 gap-2 text-[11px]">
          <div class="rounded border border-slate-200 p-2">
            <div class="mb-1 font-medium">Inbound links ({{ detail.inbound_links.length }})</div>
            <div class="max-h-24 overflow-auto space-y-1">
              <div v-for="link in detail.inbound_links" :key="`${link.source_memory_id}:${link.relation}:${link.created_at}`" class="rounded bg-slate-50 p-1">
                <div class="font-mono">{{ link.source_namespace }}/{{ link.source_key }}</div>
                <div class="text-slate-500">{{ link.relation }}</div>
              </div>
            </div>
          </div>
          <div class="rounded border border-slate-200 p-2">
            <div class="mb-1 font-medium">Outbound links ({{ detail.outbound_links.length }})</div>
            <div class="max-h-24 overflow-auto space-y-1">
              <div v-for="link in detail.outbound_links" :key="`${link.target_memory_id ?? link.target_namespace}:${link.relation}:${link.created_at}`" class="rounded bg-slate-50 p-1">
                <div class="font-mono">{{ link.target_namespace }}/{{ link.target_key }}</div>
                <div class="text-slate-500">{{ link.relation }}</div>
              </div>
            </div>
          </div>
        </div>

        <form class="space-y-2 rounded border border-slate-200 bg-slate-50 p-3" @submit.prevent="submitUpsert">
          <div class="text-xs font-medium text-slate-700">新規 / 更新</div>
          <input
            v-model="editor.user_id"
            type="text"
            class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
            placeholder="user_id"
          />
          <input
            v-model="editor.namespace"
            type="text"
            class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
            placeholder="namespace"
          />
          <input
            v-model="editor.key"
            type="text"
            class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
            placeholder="key"
          />
          <input
            v-model="editor.tags_text"
            type="text"
            class="w-full rounded border border-slate-300 px-2 py-1.5 text-xs"
            placeholder="tags (comma separated)"
          />
          <label class="flex items-center gap-2 text-xs text-slate-700">
            <input v-model="editor.is_system" type="checkbox" />
            is_system
          </label>
          <textarea
            v-model="editor.value_json_text"
            rows="10"
            class="w-full rounded border border-slate-300 px-2 py-1.5 font-mono text-[11px]"
            placeholder='{"content":"..."}'
          />
          <div class="flex gap-2">
            <button
              class="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
              :disabled="saving"
              type="submit"
            >
              {{ saving ? "Saving..." : "保存" }}
            </button>
            <button
              class="rounded border border-slate-300 px-3 py-1.5 text-xs hover:bg-white"
              type="button"
              @click="resetEditor"
            >
              リセット
            </button>
          </div>
        </form>
      </section>
    </main>

    <footer class="mx-auto mb-4 max-w-[1500px] px-5">
      <p v-if="errorMessage" class="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ errorMessage }}
      </p>
      <p v-if="infoMessage" class="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        {{ infoMessage }}
      </p>
    </footer>
  </div>
</template>
