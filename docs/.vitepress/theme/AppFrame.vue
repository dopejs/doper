<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  /** Same-origin path of the embedded static app, e.g. "/playground/". */
  src: string;
  /** Forwards the wrapper page hash into the embedded app when true. */
  forwardHash?: boolean;
}>();

const frame = ref<HTMLIFrameElement>();
const initialSource = ref(props.src);
let syncing = false;

/** Mirrors the embedded app's route into the wrapper URL so links stay shareable. */
function adoptFrameHash(): void {
  const window_ = frame.value?.contentWindow;
  if (window_ === null || window_ === undefined || syncing) return;
  let hash = "";
  try {
    hash = window_.location.hash;
  } catch {
    // A cross-origin frame cannot be inspected; leave the wrapper URL alone.
    return;
  }
  if (hash === "" || hash === location.hash) return;
  syncing = true;
  history.replaceState(null, "", `${location.pathname}${hash}`);
  syncing = false;
}

function pushHashToFrame(): void {
  const window_ = frame.value?.contentWindow;
  if (window_ === null || window_ === undefined || syncing) return;
  try {
    if (window_.location.hash === location.hash) return;
    syncing = true;
    window_.location.hash = location.hash;
  } catch {
    // Ignore frames we are not allowed to navigate.
  } finally {
    syncing = false;
  }
}

function onFrameLoad(): void {
  frame.value?.contentWindow?.addEventListener("hashchange", adoptFrameHash);
  adoptFrameHash();
}

onMounted(() => {
  if (props.forwardHash === true && location.hash !== "") {
    initialSource.value = `${props.src}${location.hash}`;
  }
  window.addEventListener("hashchange", pushHashToFrame);
});

onBeforeUnmount(() => {
  window.removeEventListener("hashchange", pushHashToFrame);
  frame.value?.contentWindow?.removeEventListener("hashchange", adoptFrameHash);
});
</script>

<template>
  <div class="app-frame">
    <iframe
      ref="frame"
      :src="initialSource"
      title="doper embedded application"
      @load="onFrameLoad"
    />
  </div>
</template>

<style scoped>
.app-frame {
  height: calc(100vh - var(--vp-nav-height));
  width: 100%;
}

.app-frame iframe {
  display: block;
  height: 100%;
  width: 100%;
  border: 0;
}
</style>
