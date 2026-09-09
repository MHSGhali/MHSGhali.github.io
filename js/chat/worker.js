/* Runs the model off the main thread when the service worker cannot be used,
   so a generation never blocks the page. Same pinned build as engine.js. */
import * as webllm from "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/+esm";

const handler = new webllm.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => { handler.onmessage(msg); };
