/**
 * Manual browser harness for the production frontend; never included by Vite.
 *
 * 1. Build the current frontend: cd frontend && npm run build
 * 2. Run the normal Tyuin backend on http://127.0.0.1:8877.
 * 3. From the repository root:
 *      node frontend/tests/assistant-browser-harness.mjs
 * 4. Open http://127.0.0.1:8878 and enter the synthetic test key
 *      sk-test-browser-only
 *    in the product's normal key dialog. Do not enter a real API key.
 * 5. Use the visible bottom-left "Mock OpenAI" panel to select responses,
 *    inspect boolean request diagnostics, and finish delayed responses.
 *    Slow responses deliberately resolve even after abort, to check that the
 *    product suppresses stale results when a key/client/tab changes.
 *
 * Optional environment: TYUIN_TEST_BACKEND=http://127.0.0.1:8877,
 * TYUIN_TEST_PORT=8878. Both listeners/proxy destinations must stay on loopback.
 * The HTTP server serves moneygraph/web, proxies only GET /api/*, and injects
 * a separate driver before the production module script. No source mutation,
 * external packages, real OpenAI requests, persisted keys, or hidden eval.
 * Counters reset on page reload. CSP additionally prevents all external fetches.
 */

import http from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = await realpath(resolve(repository, "moneygraph/web"));
const port = Number(process.env.TYUIN_TEST_PORT || "8878");
const backend = new URL(
  process.env.TYUIN_TEST_BACKEND || "http://127.0.0.1:8877",
);
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("TYUIN_TEST_PORT must be an integer from 1 to 65535.");
if (
  backend.protocol !== "http:" ||
  !loopback.has(backend.hostname) ||
  backend.username ||
  backend.password ||
  backend.pathname !== "/" ||
  backend.search ||
  backend.hash
)
  throw new Error("TYUIN_TEST_BACKEND must be an HTTP loopback origin.");
if (Number(backend.port || "80") === port)
  throw new Error("Harness and backend must use different ports.");

// This function is serialized as an external script, never evaluated by the
// harness or browser automation. It installs visible, user-operated controls.
function browserDriver() {
  "use strict";
  const syntheticKey = "sk-test-browser-only";
  const endpoint = "https://api.openai.com/v1/responses";
  const originalFetch = window.fetch.bind(window);
  const originalSetItem = Storage.prototype.setItem;
  const state = {
    mode: "success",
    requests: 0,
    aborts: 0,
    localApiKeyRequests: 0,
    storageKeyWrites: 0,
    blockedExternalRequests: 0,
    pending: [],
    contract: null,
  };
  let panel;
  let diagnostics;
  let finish;
  const hasSyntheticKey = (value) => String(value).includes(syntheticKey);
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const success = (requestNumber, delayed = false) =>
    jsonResponse({
      id: `mock-response-${requestNumber}`,
      object: "response",
      status: "completed",
      model: "gpt-4.1-mini",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: `${delayed ? "Задержанный" : "Тестовый"} ответ OpenAI №${requestNumber}. Клиент A: роль — структурная гипотеза (role), приоритет проверки не означает виновность (priority_score). Учитывайте границу наблюдения (boundary) и ограничения досье (limitations).`,
            },
          ],
        },
      ],
    });
  function render() {
    if (!diagnostics) return;
    diagnostics.textContent = JSON.stringify(
      {
        mode: state.mode,
        requests: state.requests,
        aborts: state.aborts,
        pendingSlowResponses: state.pending.length,
        localApiRequestsCarryingTestKey: state.localApiKeyRequests,
        storageWritesContainingTestKey: state.storageKeyWrites,
        blockedExternalRequests: state.blockedExternalRequests,
        lastRequestContract: state.contract,
      },
      null,
      2,
    );
    finish.disabled = state.pending.length === 0;
  }
  Storage.prototype.setItem = function (name, value) {
    if (hasSyntheticKey(name) || hasSyntheticKey(value)) {
      state.storageKeyWrites += 1;
      render();
      // Count an attempted leak without persisting even the synthetic key.
      return;
    }
    return originalSetItem.call(this, name, value);
  };
  function containsIdentifierField(value) {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, child]) =>
        /^(gid|ref|transactions|operations|nodes|edges|neighbors)$/i.test(key) ||
        containsIdentifierField(child),
    );
  }
  function containsLongIntegerText(value) {
    if (typeof value === "string") return /\d{16,}/.test(value);
    return (
      value &&
      typeof value === "object" &&
      Object.values(value).some(containsLongIntegerText)
    );
  }
  function inspectContract(request, bodyText) {
    let body;
    let facts;
    try {
      body = JSON.parse(bodyText);
      const context = body.input?.[0]?.content;
      if (typeof context === "string")
        facts = JSON.parse(context.slice(context.indexOf("\n") + 1));
    } catch {
      // Only booleans enter diagnostics; request/key/body text is never shown.
    }
    const inputs = Array.isArray(body?.input) ? body.input : [];
    return {
      exactResponsesEndpoint: request.url === endpoint,
      methodPost: request.method === "POST",
      syntheticAuthorization:
        request.headers.get("Authorization") === `Bearer ${syntheticKey}`,
      jsonContentType:
        request.headers.get("Content-Type") === "application/json",
      credentialsOmitted: request.credentials === "omit",
      redirectsDisabled: request.redirect === "error",
      cacheDisabled: request.cache === "no-store",
      modelCorrect: body?.model === "gpt-4.1-mini",
      responseStorageDisabled: body?.store === false,
      outputBounded:
        Number.isInteger(body?.max_output_tokens) &&
        body.max_output_tokens > 0 &&
        body.max_output_tokens <= 1200,
      instructionsPresent: typeof body?.instructions === "string",
      inputEndsWithUserQuestion: inputs.at(-1)?.role === "user",
      historyBounded: inputs.length > 1 && inputs.length <= 13,
      selectedClientFactsPresent: facts?.client === "Клиент A",
      factsWithoutIdentifierFields:
        Boolean(facts) && !containsIdentifierField(facts),
      factTextWithoutLongIdentifiers:
        Boolean(facts) && !containsLongIntegerText(facts),
      bodyDoesNotContainTestKey: !hasSyntheticKey(bodyText),
    };
  }
  window.fetch = async function (input, init) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const bodyText =
      request.method === "GET" || request.method === "HEAD"
        ? ""
        : await request.clone().text();
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      const headerValues = [...request.headers.values()].join("\n");
      if (
        hasSyntheticKey(request.url) ||
        hasSyntheticKey(bodyText) ||
        hasSyntheticKey(headerValues)
      ) {
        state.localApiKeyRequests += 1;
        render();
        throw new TypeError("Harness blocked a test-key request to local API.");
      }
    }
    if (request.url !== endpoint) {
      // No external request can escape, including unexpected OpenAI paths.
      // Native HTTP/script requests are independently restricted by CSP.
      if (url.origin !== location.origin) {
        state.blockedExternalRequests += 1;
        render();
        throw new TypeError("External network disabled in browser harness.");
      }
      return originalFetch(input, init);
    }
    state.requests += 1;
    const number = state.requests;
    const mode = state.mode;
    state.contract = inspectContract(request, bodyText);
    render();
    // Requests using anything but the synthetic key never go to a provider.
    if (!state.contract.syntheticAuthorization)
      return jsonResponse({ error: { code: "synthetic_key_required" } }, 401);
    let countedAbort = false;
    const recordAbort = () => {
      if (countedAbort) return;
      countedAbort = true;
      state.aborts += 1;
      render();
    };
    if (request.signal.aborted) recordAbort();
    else request.signal.addEventListener("abort", recordAbort, { once: true });
    if (mode === "slow")
      return new Promise((resolveResponse) => {
        state.pending.push(() => {
          request.signal.removeEventListener("abort", recordAbort);
          resolveResponse(success(number, true));
        });
        render();
      });
    request.signal.removeEventListener("abort", recordAbort);
    if (mode === "network") throw new TypeError("Simulated network failure.");
    if (mode === "401" || mode === "429")
      return jsonResponse({ error: { code: `mock_${mode}` } }, Number(mode));
    if (mode === "invalid")
      return new Response("invalid-json", {
        headers: { "Content-Type": "application/json" },
      });
    if (mode === "empty")
      return jsonResponse({ status: "completed", output: [] });
    if (mode === "refusal")
      return jsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "Mock refusal." }],
          },
        ],
      });
    return success(number);
  };
  function installToolbar() {
    panel = document.createElement("details");
    panel.id = "tyuin-browser-test-toolbar";
    panel.open = true;
    Object.assign(panel.style, {
      position: "fixed",
      left: "10px",
      bottom: "10px",
      width: "355px",
      maxWidth: "calc(100vw - 20px)",
      maxHeight: "52vh",
      overflow: "auto",
      zIndex: "2147483647",
      padding: "10px",
      border: "2px solid #6750a4",
      borderRadius: "8px",
      background: "#ffffff",
      color: "#182033",
      boxShadow: "0 3px 15px #0003",
      font: "12px/1.4 system-ui, sans-serif",
    });
    const summary = document.createElement("summary");
    summary.textContent = "Mock OpenAI · только локальные тесты";
    summary.style.cursor = "pointer";
    panel.append(summary);
    const note = document.createElement("p");
    note.textContent =
      "Используйте синтетический ключ из инструкции файла harness. Реальная сеть OpenAI отключена. Счётчики сбрасываются при перезагрузке.";
    panel.append(note);
    const label = document.createElement("label");
    label.textContent = "Mock OpenAI mode ";
    const select = document.createElement("select");
    select.id = "mock-openai-mode";
    select.setAttribute("aria-label", "Mock OpenAI mode");
    for (const value of [
      "success",
      "401",
      "429",
      "network",
      "invalid",
      "empty",
      "refusal",
      "slow",
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      state.mode = select.value;
      render();
    });
    label.append(select);
    panel.append(label);
    const actions = document.createElement("div");
    actions.style.marginTop = "8px";
    finish = document.createElement("button");
    finish.type = "button";
    finish.textContent = "Завершить ответ";
    finish.addEventListener("click", () => {
      state.pending.shift()?.();
      render();
    });
    actions.append(finish);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Сбросить счётчики";
    reset.style.marginLeft = "6px";
    reset.addEventListener("click", () => {
      state.requests = 0;
      state.aborts = 0;
      state.localApiKeyRequests = 0;
      state.storageKeyWrites = 0;
      state.blockedExternalRequests = 0;
      state.contract = null;
      render();
    });
    actions.append(reset);
    panel.append(actions);
    diagnostics = document.createElement("pre");
    diagnostics.id = "mock-openai-diagnostics";
    diagnostics.setAttribute("aria-label", "Mock OpenAI diagnostics");
    Object.assign(diagnostics.style, {
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      font: "11px/1.4 monospace",
      marginBottom: "0",
    });
    panel.append(diagnostics);
    document.body.append(panel);
    render();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", installToolbar, { once: true });
  else installToolbar();
}

const driver = `(${browserDriver.toString()})();\n`;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; object-src 'none'; base-uri 'self'",
  );
  const fail = (status, message) => {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(message);
  };
  if (request.method !== "GET") return fail(405, "Only GET is allowed.");
  // Parse the raw target before URL normalization can erase traversal segments.
  let pathname;
  let query;
  try {
    const target = request.url || "/";
    if (!target.startsWith("/") || target.startsWith("//"))
      return fail(400, "Invalid request target.");
    const question = target.indexOf("?");
    pathname = decodeURIComponent(question < 0 ? target : target.slice(0, question));
    query = question < 0 ? "" : target.slice(question);
    if (
      pathname.includes("\\") ||
      pathname.includes("\0") ||
      pathname.split("/").some((segment) => segment === ".." || segment === ".")
    )
      return fail(400, "Invalid path.");
  } catch {
    return fail(400, "Invalid path encoding.");
  }
  if (pathname === "/__test_driver.js") {
    response.writeHead(200, { "Content-Type": mime[".js"] });
    return response.end(driver);
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    // Only known read-only product routes are proxied. No explain/write route.
    if (
      !/^\/api\/(?:health|analysis|nodes\/\d+|clusters\/\d+|exports\/(?:nodes_roles|clusters|top_nodes)\.csv)$/.test(
        pathname,
      )
    )
      return fail(404, "Unknown test API route.");
    // Never forward incoming authorization/cookies to the product backend.
    const upstream = http.get(
      new URL(pathname + query, backend),
      { headers: { Accept: "application/json, text/csv;q=0.9" }, timeout: 10000 },
      (incoming) => {
        const headers = {
          "Content-Type": incoming.headers["content-type"] || "application/json",
        };
        if (incoming.headers["x-analysis-id"])
          headers["X-Analysis-ID"] = incoming.headers["x-analysis-id"];
        response.writeHead(incoming.statusCode || 502, headers);
        incoming.pipe(response);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("Backend timeout")));
    upstream.on("error", () => fail(502, "Local Tyuin backend is unavailable."));
    response.on("close", () => upstream.destroy());
    return;
  }
  try {
    const path = await realpath(
      resolve(webRoot, `.${pathname === "/" ? "/index.html" : pathname}`),
    );
    if (!path.startsWith(webRoot + sep)) return fail(403, "Path is outside assets.");
    const contents = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
    });
    if (extname(path) === ".html")
      return response.end(
        contents
          .toString("utf8")
          .replace("<head>", '<head>\n    <script src="/__test_driver.js"></script>'),
      );
    response.end(contents);
  } catch {
    fail(404, "Asset not found.");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Browser mock harness: http://127.0.0.1:${port}`);
  console.log(`Read-only backend proxy: ${backend.origin}`);
  console.log("Only use the synthetic key documented at the top of this file.");
});
server.on("error", (error) => {
  console.error(`Harness could not listen: ${error.code || "unknown error"}`);
  process.exitCode = 1;
});
