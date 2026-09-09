/* ---------------------------------------------------------------
   The language model itself: choosing one, loading it, and running a
   completion. One engine per browser tab, shared by every mount on the page,
   and -- through the service worker -- kept alive across navigations, so
   walking from the chat page to the linkage page does not rebuild it.
   --------------------------------------------------------------- */

/* Pinned. Every behaviour below was checked against this exact build, and the
   service worker and the dedicated worker import the same URL, so the three
   cannot drift apart.

   Imported lazily, and this matters: the runtime is about a megabyte of
   JavaScript, and the assistant panel is mounted on both simulator pages where
   most visitors will never open it. A static import would make every visit to
   the linkage tool pay for a language model nobody asked for. */
const CDN = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm";
let runtime = null;
const webllm = () => (runtime ||= import(CDN));

/* Newest and best first, resolved at runtime against whatever this build of
   WebLLM actually ships, so bumping the CDN version cannot strand the site on
   an id that no longer exists. Sizes are vram_required_MB from the same list.

   All of these run a 4096-token window, which is why profile.js sends only the
   sections a question needs rather than the whole thing.

   The Qwen3 family are hybrid reasoning models. extra_body.enable_thinking
   false is implemented by pre-seeding "<think>\n\n</think>\n\n" into the
   output, so the reply still ARRIVES with a think block and stripThink below
   has to take it off. */
const CANDIDATES = [
  "Qwen3.5-2B-q4f16_1-MLC",             // 2245 MB, the best answers here
  "Qwen3-1.7B-q4f16_1-MLC",             // 2037 MB
  "Qwen3.5-0.8B-q4f16_1-MLC",           // 1629 MB
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",  // 1630 MB, no think block
  "Qwen3-0.6B-q4f16_1-MLC",             // 1403 MB
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",  //  879 MB, last resort
];

/* A phone has to fetch and hold the same weights as a desktop and rarely has
   the memory for the top of the ladder, so it starts further down rather than
   spending a gigabyte of someone's data on a load that will fail. */
function isSmallDevice() {
  if (navigator.userAgentData?.mobile) return true;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export async function pickModels() {
  const llm = await webllm();
  const shipped = new Set((llm.prebuiltAppConfig?.model_list || []).map((m) => m.model_id));
  const live = CANDIDATES.filter((id) => shipped.has(id));
  /* An empty intersection means the CDN build changed its ids under us. Ask for
     the first candidate anyway: a clear failure naming a model beats a silent
     "nothing to load". */
  if (!live.length) return [CANDIDATES[0]];
  return isSmallDevice() ? live.slice(-3) : live;
}

export const THINK = /<think>[\s\S]*?(?:<\/think>|$)/g;
export const stripThink = (t) => t.replace(THINK, "");

/* --------------------------------------------------------------- capability */

export async function webgpuProblem() {
  /* WebGPU is a secure-context API, so `navigator.gpu` is simply absent over
     plain http. Checked FIRST, because the symptom is identical to an old
     browser and the advice is not: telling someone testing on their phone over
     a LAN address that their browser is too old sends them to fix the wrong
     thing. localhost is exempt, which is why this never shows up in
     development. */
  if (!window.isSecureContext) {
    return {
      title: "This page is not on a secure connection.",
      detail: "WebGPU is only available over https (or on localhost), so the model cannot start "
        + "here. On the published site it works; over a plain http address, such as a phone "
        + "opening a computer on the same network, it cannot. Everything else on this page "
        + "still works.",
    };
  }
  if (!("gpu" in navigator)) {
    return {
      title: "This browser cannot run the model.",
      detail: "The chat needs WebGPU, which Chrome, Edge, Arc and Safari 26 or newer have. "
        + "Firefox and older Safari do not yet. Everything else on this site still works.",
    };
  }
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); } catch (e) { /* reported below */ }
  if (!adapter) {
    return {
      title: "No compatible GPU found.",
      detail: "The browser supports WebGPU but could not get a GPU adapter, which usually means "
        + "hardware acceleration is switched off or the GPU is blocklisted.",
    };
  }
  return null;
}

/* ------------------------------------------------------------------ engine */

let enginePromise = null;   /* the in-flight or finished load, shared by mounts */
let engineInfo = null;      /* {engine, modelId, transport} once it is up */

export const currentModel = () => engineInfo?.modelId || null;
export const isLive = () => !!engineInfo;

/* Is the top model already on this device? Answered without pulling the
   runtime in the common case: if this origin holds no WebLLM cache at all, the
   answer is no and there is nothing to ask. Only a visitor who has loaded a
   model before pays for the real check. */
export async function cachedAlready() {
  try {
    if (!("caches" in window)) return false;
    const keys = await caches.keys();
    if (!keys.some((k) => /webllm|mlc/i.test(k))) return false;
    const llm = await webllm();
    return await llm.hasModelInCache((await pickModels())[0]);
  } catch (e) { return false; }
}

/* Was the model loaded earlier in this browsing session? Written once the
   engine is up, read by pages that would otherwise wake the runtime for a
   visitor who never opened the chat at all. */
const LIVE_KEY = "chat-engine-live";
export const wasLiveThisSession = () => {
  try { return sessionStorage.getItem(LIVE_KEY) === "1"; } catch (e) { return false; }
};

async function chooseTransport() {
  /* The service worker outlives a navigation, so the model stays resident when
     the visitor moves between the chat and the simulators. A dedicated worker
     is rebuilt on every page, which is the difference between an instant chat
     panel and a thirty second wait. */
  try {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      await navigator.serviceWorker.register(new URL("../../sw.js", import.meta.url), { type: "module" });
      await navigator.serviceWorker.ready;
      /* Registered and active is not the same as CONTROLLING this page: on a
         first visit the page is uncontrolled until the worker claims it, and
         WebLLM throws "There is no active service worker" if it posts before
         then. Wait for the claim, but never hang on one that does not come. */
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
          setTimeout(resolve, 4000);
        });
      }
      if (navigator.serviceWorker.controller) return "service worker";
    }
  } catch (e) {
    console.warn("service worker unavailable, using a dedicated worker", e);
  }
  return "worker";
}

let dedicated = null;
const getDedicated = () => (dedicated ||= new Worker(workerUrl(), { type: "module" }));

/* Carry this module's ?v= tag onto the worker URL. new URL() drops the query,
   and the build script only reaches import specifiers, so without this the one
   file it cannot stamp would be served from cache after a deploy. Same trick as
   startWorker() in js/light/app.js. */
function workerUrl() {
  const url = new URL("./worker.js", import.meta.url);
  url.search = new URL(import.meta.url).search;
  return url;
}

/* onProgress: (report) => void, WebLLM's own init report.
   onStage:    (text) => void, for the human-facing line under the bar. */
export function loadEngine({ onProgress, onStage } = {}) {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    /* Cache storage is best-effort by default, so a browser under disk pressure
       can evict a gigabyte of weights and force the whole download again on the
       next visit. Asking for persistence exempts this origin from that. */
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (e) { /* not fatal: the model still caches, just evictably */ }

    const llm = await webllm();
    const preferred = await chooseTransport();
    /* Two models, and for each the preferred transport then the fallback. That
       covers a transient CDN failure and a service worker that cannot serve
       this visitor, without turning a dead network into eight silent tries. */
    const models = (await pickModels()).slice(0, 2);
    const transports = preferred === "service worker" ? ["service worker", "worker"] : ["worker"];

    let lastErr = null;
    for (const modelId of models) {
      for (const transport of transports) {
        try {
          const opts = { initProgressCallback: onProgress };
          const engine = transport === "service worker"
            ? await llm.CreateServiceWorkerMLCEngine(modelId, opts)
            : await llm.CreateWebWorkerMLCEngine(getDedicated(), modelId, opts);
          engineInfo = { engine, modelId, transport };
          try { sessionStorage.setItem(LIVE_KEY, "1"); } catch (e) { /* private mode */ }
          return engineInfo;
        } catch (err) {
          lastErr = err;
          console.warn(`${modelId} failed to load via ${transport}`, err);
          onStage?.("Hit a snag fetching the weights, trying another way…");
        }
      }
    }
    enginePromise = null;   /* let a later attempt start clean */
    throw lastErr || new Error("no model could be loaded");
  })();

  return enginePromise;
}

/* A short real generation on the real prompt, so the visitor never pays shader
   compilation and first-run kernel setup on their own first question. It cannot
   remove per-message prefill: WebLLM rebuilds the conversation from `messages`
   every call and keeps no prefix cache across requests. */
export async function warmUp(systemPrompt) {
  if (!engineInfo) return;
  try {
    await engineInfo.engine.chat.completions.create({
      messages: [{ role: "system", content: systemPrompt },
                 { role: "user", content: "Which company does Mark work for?" }],
      max_tokens: 8, temperature: 0.1,
      extra_body: { enable_thinking: false },
    });
  } catch (e) {
    console.warn("warm-up failed; the first answer will be slower", e);
  }
}

export function interrupt() {
  try { engineInfo?.engine.interruptGenerate(); } catch (e) { /* nothing running */ }
}

/* Near-greedy on purpose: this is grounded lookup over a fixed profile, not
   creative writing, so the most probable answer every time is the right one.
   Low temperature makes small models prone to repetition loops, which is what
   the frequency penalty is there to break; the two go together. */
export async function* stream(messages, { maxTokens = 240 } = {}) {
  if (!engineInfo) throw new Error("the model is not loaded");
  const s = await engineInfo.engine.chat.completions.create({
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.1,
    top_p: 0.9,
    frequency_penalty: 0.7,
    presence_penalty: 0.4,
    max_tokens: maxTokens,
    extra_body: { enable_thinking: false },
  });
  yield* s;
}
