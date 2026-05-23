(function () {
  "use strict";

  const SAMPLES = {
    python: `# 示例：含多种常见问题的 Python 代码
import pickle
import subprocess

password = "admin123_secret"
API_KEY = "sk-abc123xyz"

def process_items(items=[]):
    result = ""
    for i in range(len(items)):
        result += str(items[i])
    return result

def fetch_user(user_id):
    query = f"SELECT * FROM users WHERE id = {user_id}"
    cursor.execute(query)

def run_cmd(cmd):
    subprocess.call(cmd, shell=True)

def load_data(data):
    return pickle.loads(data)

try:
    risky()
except:
    pass

if value == None:
    print("debug:", value)

# TODO: refactor this module
`,

    cpp: `// 示例：含多种常见问题的 C++ 代码
#include <iostream>
#include <vector>
using namespace std;

void process(vector<string> data) {
    char buffer[64];
    gets(buffer);
    strcpy(buffer, data[0].c_str());

    int* ptr = new int[100];
    // 忘记 delete[]

    for (int i = 0; i < 1000; i++) {
        data.push_back("item");
    }

    if (ptr == NULL) {
        cout << *ptr << endl;
    }

    system("rm -rf /tmp/*");
}

int main() {
    vector<string> items;
    process(items);
    printf("done\\n");
    return 0;
}

// TODO: add error handling
`,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const codeInput = $("#code-input");
  const lineNumbers = $("#line-numbers");
  const langSelect = $("#lang-select");
  const modeSelect = $("#mode-select");
  const detectedLang = $("#detected-lang");
  const codeStats = $("#code-stats");
  const issuesList = $("#issues-list");
  const scoreText = $("#score-text");
  const scoreFill = $("#score-fill");
  const scoreRing = $("#score-ring");
  const llmStatus = $("#llm-status");

  let currentResult = null;
  let activeFilter = "all";
  let isBusy = false;

  function updateLineNumbers() {
    const lines = codeInput.value.split("\n");
    const count = Math.max(lines.length, 1);
    lineNumbers.textContent = Array.from({ length: count }, (_, i) => i + 1).join("\n");
    lineNumbers.scrollTop = codeInput.scrollTop;
  }

  function updateStats() {
    const text = codeInput.value;
    const lines = text ? text.split("\n").length : 0;
    codeStats.textContent = `${lines} 行 · ${text.length} 字符`;

    if (text.trim()) {
      const lang = CodeReviewEngine.detectLanguage(text);
      const labels = { python: "Python", cpp: "C++", unknown: "未知" };
      detectedLang.textContent = labels[lang] || "未知";
    } else {
      detectedLang.textContent = "未检测";
    }
  }

  function setBusy(busy, message) {
    isBusy = busy;
    $("#btn-review").disabled = busy;
    $("#btn-optimize").disabled = busy;
    if (busy && message) {
      llmStatus.className = "llm-status loading";
      llmStatus.textContent = message;
    } else if (!busy) {
      llmStatus.className = "llm-status";
      llmStatus.textContent = "";
    }
  }

  function showLlmStatus(type, message) {
    llmStatus.className = `llm-status ${type}`;
    llmStatus.textContent = message;
  }

  function loadConfigToForm() {
    const stored = LLMClient.getStoredConfig();
    $("#cfg-base-url").value = stored.baseUrl || "";
    $("#cfg-api-key").value = stored.apiKey || "";
    $("#cfg-model").value = stored.model || "";
  }

  function updateConfigStatus() {
    const el = $("#config-status");
    if (!el) return;
    const err = LLMClient.configError();
    if (err) {
      el.className = "config-status error";
      el.textContent = "⚠ " + err;
    } else {
      const cfg = LLMClient.getConfig();
      el.className = "config-status ok";
      el.textContent = `✓ 已保存 — ${cfg.baseUrl} / ${cfg.model}`;
    }
  }

  function saveConfigFromForm() {
    const baseUrl = $("#cfg-base-url").value.trim();
    const apiKey = $("#cfg-api-key").value.trim();
    const model = $("#cfg-model").value.trim();

    if (!baseUrl || !model) {
      alert("请填写 API 地址和模型名称");
      return false;
    }

    LLMClient.saveConfig({ baseUrl, apiKey, model });
    updateConfigStatus();
    showLlmStatus("ok", "✓ LLM 配置已保存");
    return true;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function renderIssues(result) {
    if (!result.issues.length) {
      issuesList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">✅</div>
          <p>未发现问题</p>
          <p class="empty-hint">代码质量良好，评分 ${result.score}/100</p>
        </div>`;
      return;
    }

    const sevLabels = { critical: "严重", warning: "警告", info: "提示", suggestion: "建议" };

    issuesList.innerHTML = result.issues
      .map(
        (issue, idx) => `
      <div class="issue-card" data-index="${idx}" data-severity="${issue.severity}" data-category="${issue.category}" data-line="${issue.line}">
        <div class="issue-header">
          <span class="severity-tag ${issue.severity}">${sevLabels[issue.severity] || issue.severity}</span>
          <span class="category-tag">${CodeReviewEngine.CATEGORY_LABELS[issue.category] || issue.category}</span>
          ${issue.source === "llm" ? '<span class="source-tag">AI</span>' : '<span class="source-tag static">规则</span>'}
          <span class="line-ref">L${issue.line}</span>
        </div>
        <div class="issue-title">${escapeHtml(issue.rule)}</div>
        <p class="issue-message">${escapeHtml(issue.message)}</p>
        ${issue.suggestion ? `<div class="issue-suggestion">💡 ${escapeHtml(issue.suggestion)}</div>` : ""}
        ${issue.snippet ? `<pre class="issue-code">${escapeHtml(issue.snippet)}</pre>` : ""}
        <div class="issue-actions">
          <button class="btn btn-sm btn-ai-fix" type="button" data-fix-index="${idx}">🤖 AI 修复</button>
        </div>
        <div class="ai-fix-result" id="fix-result-${idx}" hidden></div>
      </div>`
      )
      .join("");

    applyFilter();
    bindIssueClicks();
    bindFixButtons();
  }

  function bindIssueClicks() {
    $$(".issue-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".btn-ai-fix") || e.target.closest(".ai-fix-result")) return;
        const line = parseInt(card.dataset.line, 10);
        highlightLine(line);
        $$(".issue-card").forEach((c) => c.classList.remove("highlight"));
        card.classList.add("highlight");
      });
    });
  }

  function bindFixButtons() {
    $$(".btn-ai-fix").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (isBusy) return;

        const idx = parseInt(btn.dataset.fixIndex, 10);
        const issue = currentResult?.issues[idx];
        if (!issue) return;

        const resultEl = $(`#fix-result-${idx}`);
        resultEl.hidden = false;
        resultEl.className = "ai-fix-result loading";
        resultEl.textContent = "AI 正在分析修复方案…";
        btn.disabled = true;

        try {
          const lang = currentResult.language;
          const fix = await LLMClient.fixIssue(codeInput.value, lang, issue);
          resultEl.className = "ai-fix-result";
          const code = fix.fixedCode || fix.fullCode || "";
          resultEl.innerHTML = `
            ${fix.explanation ? `<p class="fix-explanation">${escapeHtml(fix.explanation)}</p>` : ""}
            ${code ? `<pre class="issue-code fix-code">${escapeHtml(code)}</pre>` : ""}
            ${fix.fullCode ? `<button class="btn btn-sm btn-apply-fix" type="button" data-apply-full="1">应用完整修复</button>` : ""}
            ${code && !fix.fullCode ? `<button class="btn btn-sm btn-apply-fix" type="button" data-apply-snippet="1">复制修复代码</button>` : ""}
          `;

          resultEl.querySelector(".btn-apply-fix")?.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (fix.fullCode) {
              if (confirm("将用 AI 修复后的完整代码替换编辑器内容，是否继续？")) {
                codeInput.value = fix.fullCode;
                updateLineNumbers();
                updateStats();
              }
            } else if (code) {
              navigator.clipboard.writeText(code).then(() => alert("修复代码已复制到剪贴板"));
            }
          });
        } catch (err) {
          resultEl.className = "ai-fix-result error";
          resultEl.textContent = "修复失败：" + err.message;
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function highlightLine(lineNum) {
    const lines = codeInput.value.split("\n");
    let pos = 0;
    for (let i = 0; i < lineNum - 1 && i < lines.length; i++) {
      pos += lines[i].length + 1;
    }
    codeInput.focus();
    codeInput.setSelectionRange(pos, pos + (lines[lineNum - 1] || "").length);
    const lineHeight = 13 * 1.6;
    codeInput.scrollTop = Math.max(0, (lineNum - 3) * lineHeight);
  }

  function updateScore(result) {
    scoreText.textContent = result.score;
    scoreRing.dataset.score = result.score;
    scoreFill.setAttribute("stroke-dasharray", `${result.score}, 100`);
    scoreFill.setAttribute("stroke", CodeReviewEngine.scoreColor(result.score));

    $("#count-critical").textContent = result.summary.critical;
    $("#count-warning").textContent = result.summary.warning;
    $("#count-info").textContent = result.summary.info;
    $("#count-suggestion").textContent = result.summary.suggestion;
  }

  function applyFilter() {
    $$(".issue-card").forEach((card) => {
      if (activeFilter === "all") {
        card.classList.remove("hidden");
      } else {
        card.classList.toggle("hidden", card.dataset.category !== activeFilter);
      }
    });
  }

  async function runReview() {
    const code = codeInput.value.trim();
    if (!code) {
      alert("请先输入代码");
      return;
    }

    const lang = langSelect.value;
    const mode = modeSelect.value;

    if ((mode === "llm" || mode === "hybrid") && !LLMClient.isConfigured()) {
      alert(LLMClient.configError() + "\n\n请点击右上角 ⚙ LLM 填写配置。");
      return;
    }

    setBusy(true, mode === "static" ? "正在静态分析…" : "正在分析代码…");

    try {
      let result = CodeReviewEngine.review(code, lang);
      result.mode = "static";

      if (result.language === "unknown") {
        currentResult = result;
        updateScore(result);
        renderIssues(result);
        return;
      }

      if (mode === "llm" || mode === "hybrid") {
        showLlmStatus("loading", "🤖 LLM 深度审查中，请稍候…");
        const llmIssues = await LLMClient.reviewCode(code, result.language, mode === "hybrid" ? result.issues : []);

        if (mode === "llm") {
          const lineCount = code.split("\n").length;
          const summary = { critical: 0, warning: 0, info: 0, suggestion: 0 };
          for (const i of llmIssues) summary[i.severity] = (summary[i.severity] || 0) + 1;
          result = {
            language: result.language,
            issues: llmIssues,
            score: CodeReviewEngine.computeScore(llmIssues, lineCount),
            lineCount,
            summary,
            mode: "llm",
          };
        } else {
          result = CodeReviewEngine.mergeResults(result, llmIssues);
        }
        showLlmStatus("ok", `✓ LLM 审查完成，新增 ${llmIssues.length} 条 AI 分析结果`);
      }

      currentResult = result;
      updateScore(result);
      renderIssues(result);
    } catch (err) {
      showLlmStatus("error", "✗ " + err.message);
      alert("审查失败：" + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runOptimize() {
    const code = codeInput.value.trim();
    if (!code) {
      alert("请先输入代码");
      return;
    }
    if (!LLMClient.isConfigured()) {
      alert(LLMClient.configError() + "\n\n请点击右上角 ⚙ LLM 填写配置。");
      return;
    }
    if (!confirm("AI 将分析并修复代码中的问题，替换编辑器内容。是否继续？")) return;

    setBusy(true, "🤖 AI 正在优化代码…");

    try {
      let lang = langSelect.value;
      if (lang === "auto") {
        lang = CodeReviewEngine.detectLanguage(code);
      }
      if (lang === "unknown") {
        alert("无法识别代码语言，请手动选择");
        return;
      }

      const issues = currentResult?.issues || CodeReviewEngine.review(code, lang).issues;
      const optimized = await LLMClient.optimizeCode(code, lang, issues);
      codeInput.value = optimized;
      updateLineNumbers();
      updateStats();
      showLlmStatus("ok", "✓ 代码已优化，建议重新审查确认结果");
    } catch (err) {
      showLlmStatus("error", "✗ " + err.message);
      alert("优化失败：" + err.message);
    } finally {
      setBusy(false);
    }
  }

  function exportReport() {
    if (!currentResult) {
      alert("请先运行代码审查");
      return;
    }
    const report = CodeReviewEngine.exportReport(currentResult, codeInput.value);
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `code-review-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Events
  codeInput.addEventListener("input", () => {
    updateLineNumbers();
    updateStats();
  });

  codeInput.addEventListener("scroll", () => {
    lineNumbers.scrollTop = codeInput.scrollTop;
  });

  $("#btn-review").addEventListener("click", runReview);
  $("#btn-optimize").addEventListener("click", runOptimize);

  $("#btn-clear").addEventListener("click", () => {
    codeInput.value = "";
    updateLineNumbers();
    updateStats();
    currentResult = null;
    scoreText.textContent = "—";
    scoreFill.setAttribute("stroke-dasharray", "0, 100");
    llmStatus.textContent = "";
    llmStatus.className = "llm-status";
    issuesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>输入代码并点击「开始审查」</p>
        <p class="empty-hint">静态规则 + LLM 深度分析，支持 AI 自动修复</p>
      </div>`;
    ["critical", "warning", "info", "suggestion"].forEach((s) => {
      $(`#count-${s}`).textContent = "0";
    });
  });

  $$("[data-sample]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.dataset.sample;
      codeInput.value = SAMPLES[lang];
      langSelect.value = lang;
      modeSelect.value = "static";
      updateLineNumbers();
      updateStats();
      runReview();
    });
  });

  $("#file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      codeInput.value = ev.target.result;
      const ext = file.name.split(".").pop().toLowerCase();
      if (ext === "py") langSelect.value = "python";
      else if (["cpp", "cc", "cxx", "h", "hpp", "hxx", "c"].includes(ext)) langSelect.value = "cpp";
      updateLineNumbers();
      updateStats();
    };
    reader.readAsText(file);
  });

  $$(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $$(".filter-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.dataset.filter;
      applyFilter();
    });
  });

  $("#btn-export").addEventListener("click", exportReport);

  $("#btn-theme").addEventListener("click", () => {
    const html = document.documentElement;
    const isLight = html.getAttribute("data-theme") === "light";
    html.setAttribute("data-theme", isLight ? "dark" : "light");
    $("#btn-theme").textContent = isLight ? "☾" : "☀";
  });

  const settingsDialog = $("#settings-dialog");
  $("#btn-settings").addEventListener("click", () => {
    loadConfigToForm();
    updateConfigStatus();
    settingsDialog.showModal();
  });
  $("#btn-close-settings").addEventListener("click", () => settingsDialog.close());

  $("#llm-config-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (saveConfigFromForm()) settingsDialog.close();
  });

  $("#btn-clear-config").addEventListener("click", () => {
    if (!confirm("确定清除已保存的 LLM 配置？")) return;
    LLMClient.clearConfig();
    loadConfigToForm();
    updateConfigStatus();
    showLlmStatus("info", "LLM 配置已清除");
  });

  codeInput.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runReview();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const start = codeInput.selectionStart;
      codeInput.value = codeInput.value.slice(0, start) + "    " + codeInput.value.slice(codeInput.selectionEnd);
      codeInput.selectionStart = codeInput.selectionEnd = start + 4;
      updateLineNumbers();
    }
  });

  updateLineNumbers();
  updateStats();
  loadConfigToForm();
  updateConfigStatus();
})();
