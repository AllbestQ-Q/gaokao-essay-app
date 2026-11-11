/* ===== 高考满分作文智能应用 · 前端逻辑 ===== */
"use strict";

const $ = (id) => document.getElementById(id);

const topicEl = $("topic");
const materialEl = $("material");
const generateBtn = $("generate-btn");
const stopBtn = $("stop-btn");
const regenBtn = $("regen-btn");
const copyBtn = $("copy-btn");
const patternsBtn = $("patterns-btn");
const essayArea = $("essay-area");
const placeholderEl = $("placeholder");
const essayEl = $("essay");
const charCountEl = $("char-count");
const counterStatusEl = $("counter-status");
const progressBarEl = $("progress-bar");
const errorBoxEl = $("error-box");
const modelTagEl = $("model-tag");
const setupBanner = $("setup-banner");

const MIN_CHARS = 800;
const MAX_CHARS = 900;

let currentStyle = "auto";
let streaming = false;
let abortController = null;
let lastPayload = null;
let essayState = { title: "", paras: [], done: false };

/* ---------- 工具函数 ---------- */

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function countChars(text) {
  // 字数 = 非空白字符数（含标点）
  return (text.match(/\S/g) || []).length;
}

function showError(msg) {
  errorBoxEl.textContent = msg;
  errorBoxEl.classList.remove("hidden");
}

function clearError() {
  errorBoxEl.classList.add("hidden");
  errorBoxEl.textContent = "";
}

/* ---------- 文体选择 ---------- */

document.querySelectorAll(".pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    currentStyle = pill.dataset.style;
  });
});

/* ---------- 作文渲染 ---------- */

function renderEssay() {
  const { title, paras, done } = essayState;
  let html = "";
  if (title) html += `<h3 class="essay-title">${escapeHtml(title)}</h3>`;

  paras.forEach((p, i) => {
    const isLast = i === paras.length - 1;
    const cursor = !done && isLast ? '<span class="cursor"></span>' : "";
    html += `<p>${escapeHtml(p)}${cursor}</p>`;
  });

  if (!done && !title && paras.length === 0) {
    html = '<p style="text-indent:0;color:#8a8073">正在构思<span class="cursor"></span></p>';
  } else if (!done && paras.length === 0) {
    html += '<span class="cursor"></span>';
  }

  essayEl.innerHTML = html;
  updateCounter();
  // 自动滚动到底部
  essayArea.scrollTop = essayArea.scrollHeight;
}

function reparseEssay(rawText) {
  const lines = rawText.split("\n");
  let title = "";
  const paras = [];
  let buf = "";
  for (const line of lines) {
    const t = line.trim();
    if (!title && !paras.length && buf === "" && t === "") continue;
    if (!title && t) {
      // 第一行非空内容作为标题（去掉可能的书名号/前缀）
      title = t.replace(/^标题[:：]\s*/, "").replace(/^《(.+)》$/, "$1");
      continue;
    }
    if (t) {
      buf += t; // 同段内换行合并
    } else if (buf) {
      paras.push(buf);
      buf = "";
    }
  }
  if (buf) paras.push(buf);
  essayState.title = title;
  essayState.paras = paras;
}

function updateCounter() {
  const bodyText = essayState.paras.join("");
  const n = countChars(bodyText);
  charCountEl.textContent = String(n);

  const pct = Math.min(100, (n / MAX_CHARS) * 100);
  progressBarEl.style.width = pct + "%";

  progressBarEl.classList.remove("ok", "high");
  counterStatusEl.classList.remove("ok", "low", "high");

  if (streaming) {
    counterStatusEl.textContent = "";
    return;
  }
  if (n === 0) {
    counterStatusEl.textContent = "";
  } else if (n < MIN_CHARS) {
    progressBarEl.classList.add("high");
    counterStatusEl.classList.add("low");
    counterStatusEl.textContent = `（偏少 ${MIN_CHARS - n} 字）`;
  } else if (n <= MAX_CHARS) {
    progressBarEl.classList.add("ok");
    counterStatusEl.classList.add("ok");
    counterStatusEl.textContent = "✓ 字数达标";
  } else {
    progressBarEl.classList.add("high");
    counterStatusEl.classList.add("high");
    counterStatusEl.textContent = `（超出 ${n - MAX_CHARS} 字）`;
  }
}

/* ---------- 生成（SSE 流式） ---------- */

function setStreamingUI(on) {
  streaming = on;
  generateBtn.disabled = on;
  topicEl.disabled = on;
  materialEl.disabled = on;
  stopBtn.classList.toggle("hidden", !on);
  if (on) {
    copyBtn.classList.add("hidden");
    regenBtn.classList.add("hidden");
  }
}

async function generate() {
  const topic = topicEl.value.trim();
  if (!topic) {
    topicEl.focus();
    showError("请先输入作文题目。");
    return;
  }
  clearError();
  lastPayload = { topic, material: materialEl.value.trim(), style: currentStyle };

  // 重置输出区
  essayState = { title: "", paras: [], done: false };
  placeholderEl.classList.add("hidden");
  essayEl.classList.remove("hidden");
  essayEl.innerHTML = "";
  charCountEl.textContent = "0";
  progressBarEl.style.width = "0%";
  setStreamingUI(true);
  renderEssay();

  abortController = new AbortController();
  let rawText = "";

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lastPayload),
      signal: abortController.signal,
    });

    if (!resp.ok || !resp.body) {
      let detail = `HTTP ${resp.status}`;
      try {
        const j = await resp.json();
        if (j.detail) detail = typeof j.detail === "string" ? j.detail : "输入格式不正确（题目不能为空）。";
      } catch (_) { /* ignore */ }
      throw new Error(detail);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!rawEvent.startsWith("data:")) continue;
        let evt;
        try {
          evt = JSON.parse(rawEvent.slice(5).trim());
        } catch (_) {
          continue;
        }
        handleEvent(evt);
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      showError(`生成失败：${err.message}`);
    }
  } finally {
    essayState.done = true;
    setStreamingUI(false);
    renderEssay();
    if (essayState.title || essayState.paras.length) {
      copyBtn.classList.remove("hidden");
      regenBtn.classList.remove("hidden");
    }
    abortController = null;
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case "meta":
        modelTagEl.textContent = `模型：${evt.model}`;
        break;
      case "delta":
        rawText += evt.text;
        reparseEssay(rawText);
        renderEssay();
        break;
      case "done":
        essayState.done = true;
        break;
      case "error":
        showError(evt.message);
        essayState.done = true;
        break;
    }
  }
}

generateBtn.addEventListener("click", generate);
regenBtn.addEventListener("click", generate);
stopBtn.addEventListener("click", () => {
  if (abortController) abortController.abort();
});

topicEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !streaming) generate();
});

/* ---------- 复制 ---------- */

copyBtn.addEventListener("click", async () => {
  const text = [essayState.title, "", ...essayState.paras.map((p) => "　　" + p)].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "✓ 已复制";
  } catch (_) {
    // 兜底：textarea 复制
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    copyBtn.textContent = "✓ 已复制";
  }
  setTimeout(() => (copyBtn.textContent = "📋 复制全文"), 1600);
});

/* ---------- 规律弹窗（含极简 markdown 渲染） ---------- */

function renderMarkdown(md) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = md.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
      continue;
    }
    closeList();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const lv = h[1].length;
      html += `<h${lv}>${inline(h[2])}</h${lv}>`;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { html += "<hr>"; continue; }
    if (line.startsWith(">")) {
      html += `<blockquote>${inline(line.replace(/^>\s*/, ""))}</blockquote>`;
      continue;
    }
    if (!line.trim()) continue;
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

const modal = $("patterns-modal");
const patternsBody = $("patterns-body");
let patternsLoaded = false;

patternsBtn.addEventListener("click", async () => {
  modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if (patternsLoaded) return;
  try {
    const resp = await fetch("/api/patterns");
    const data = await resp.json();
    patternsBody.innerHTML = renderMarkdown(data.markdown || "暂无内容");
    patternsLoaded = true;
  } catch (err) {
    patternsBody.textContent = `加载失败：${err.message}`;
  }
});

function closeModal() {
  modal.classList.add("hidden");
  document.body.style.overflow = "";
}
$("modal-close").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* ---------- 启动时健康检查 ---------- */

(async function init() {
  try {
    const resp = await fetch("/api/health");
    const data = await resp.json();
    modelTagEl.textContent = `模型：${data.model}`;
    if (!data.configured) {
      $("banner-model").textContent = `${data.model} @ ${data.base_url}`;
      setupBanner.classList.remove("hidden");
    }
  } catch (_) {
    /* 后端未就绪时静默 */
  }
})();
