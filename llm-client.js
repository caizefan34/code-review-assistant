/**
 * LLM 客户端 — OpenAI 兼容 Chat Completions API
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "code-review-llm-config";

  function loadStoredConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function clearStoredConfig() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function saveStoredConfig(partial) {
    const next = { ...loadStoredConfig(), ...partial };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  }

  function getConfig() {
    const stored = loadStoredConfig();
    const defaults = global.LLM_DEFAULTS || {};
    return {
      ...defaults,
      baseUrl: stored.baseUrl || "",
      apiKey: stored.apiKey || "",
      model: stored.model || "",
    };
  }

  function getStoredConfig() {
    return loadStoredConfig();
  }

  function isConfigured() {
    const cfg = getConfig();
    if (!cfg.enabled) return false;
    return Boolean(cfg.baseUrl && cfg.model);
  }

  function configError() {
    const cfg = getConfig();
    const missing = [];
    if (!cfg.baseUrl) missing.push("baseUrl（API 地址）");
    if (!cfg.model) missing.push("model（模型名称）");
    if (missing.length) {
      return `LLM 未配置完整，请点击右上角 ⚙ LLM 填写：${missing.join("、")}`;
    }
    if (!cfg.enabled) return "LLM 功能已禁用";
    return null;
  }

  function endpoint() {
    const base = getConfig().baseUrl.replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  async function chat(messages, options = {}) {
    const err = configError();
    if (err) throw new Error(err);

    const cfg = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout || 120000);

    try {
      const headers = { "Content-Type": "application/json" };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(endpoint(), {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: options.temperature ?? cfg.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? cfg.maxTokens ?? 4096,
          ...(options.responseFormat ? { response_format: options.responseFormat } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`LLM 请求失败 (${res.status}): ${body.slice(0, 300)}`);
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("LLM 返回内容为空");
      return content.trim();
    } catch (e) {
      if (e.name === "AbortError") throw new Error("LLM 请求超时，请检查网络或增大 timeout");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1].trim() : text.trim();
    try {
      return JSON.parse(raw);
    } catch {
      const arr = raw.match(/\[[\s\S]*\]/);
      const obj = raw.match(/\{[\s\S]*\}/);
      if (arr) return JSON.parse(arr[0]);
      if (obj) return JSON.parse(obj[0]);
      throw new Error("无法解析 LLM 返回的 JSON");
    }
  }

  function extractCode(text) {
    const fenced = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    return fenced ? fenced[1].trim() : text.trim();
  }

  const LANG_NAMES = { python: "Python", cpp: "C++" };

  function buildReviewPrompt(code, lang, staticIssues) {
    const langName = LANG_NAMES[lang] || lang;
    const staticHint = staticIssues?.length
      ? `\n\n静态分析已发现 ${staticIssues.length} 个问题，请参考并补充更深层的问题：\n${staticIssues
          .slice(0, 15)
          .map((i) => `- L${i.line} [${i.severity}] ${i.rule}: ${i.message}`)
          .join("\n")}`
      : "";

    return [
      {
        role: "system",
        content: `你是资深 ${langName} 代码审查专家。分析代码并找出安全漏洞、Bug、性能问题、风格问题和最佳实践违规。
严格以 JSON 数组格式回复，不要输出其他文字。每个元素格式：
{"line":行号,"severity":"critical|warning|info|suggestion","category":"security|bug|performance|style|best-practice","rule":"规则名","message":"问题描述","suggestion":"修复建议","snippet":"相关代码片段"}`,
      },
      {
        role: "user",
        content: `请审查以下 ${langName} 代码：\n\`\`\`\n${code}\n\`\`\`${staticHint}`,
      },
    ];
  }

  function buildFixPrompt(code, lang, issue) {
    const langName = LANG_NAMES[lang] || lang;
    return [
      {
        role: "system",
        content: `你是 ${langName} 专家。针对给定问题提供精确的修复方案。
回复 JSON 格式：{"explanation":"修复思路","fixedCode":"修复后的代码片段","fullCode":"修复后完整代码（可选）"}`,
      },
      {
        role: "user",
        content: `原始代码：\n\`\`\`\n${code}\n\`\`\`\n\n问题（第 ${issue.line} 行）：${issue.rule}\n${issue.message}\n${issue.suggestion ? "建议：" + issue.suggestion : ""}\n\n请给出修复方案。`,
      },
    ];
  }

  function buildOptimizePrompt(code, lang, issues) {
    const langName = LANG_NAMES[lang] || lang;
    const issueList = issues
      .map((i) => `- L${i.line} [${i.severity}] ${i.rule}: ${i.message}`)
      .join("\n");

    return [
      {
        role: "system",
        content: `你是 ${langName} 专家。根据审查问题列表修复并优化代码，保持原有功能不变。只输出修复后的完整代码，用代码块包裹，不要额外解释。`,
      },
      {
        role: "user",
        content: `以下 ${langName} 代码存在这些问题：\n${issueList || "（无具体问题，请做通用优化）"}\n\n请输出修复后的完整代码：\n\`\`\`\n${code}\n\`\`\``,
      },
    ];
  }

  function normalizeIssues(raw, source = "llm") {
    if (!Array.isArray(raw)) {
      if (raw?.issues) raw = raw.issues;
      else return [];
    }

    const validSev = new Set(["critical", "warning", "info", "suggestion"]);
    const validCat = new Set(["security", "bug", "performance", "style", "best-practice"]);

    return raw
      .filter((item) => item && typeof item === "object")
      .map((item, idx) => ({
        id: `llm-${source}-${idx}`,
        line: Math.max(1, parseInt(item.line, 10) || 1),
        severity: validSev.has(item.severity) ? item.severity : "info",
        category: validCat.has(item.category) ? item.category : "best-practice",
        rule: String(item.rule || "AI 审查"),
        message: String(item.message || ""),
        suggestion: item.suggestion ? String(item.suggestion) : undefined,
        snippet: item.snippet ? String(item.snippet) : undefined,
        source,
      }))
      .filter((i) => i.message);
  }

  async function reviewCode(code, lang, staticIssues = []) {
    const content = await chat(buildReviewPrompt(code, lang, staticIssues));
    const parsed = extractJson(content);
    return normalizeIssues(parsed);
  }

  async function fixIssue(code, lang, issue) {
    const content = await chat(buildFixPrompt(code, lang, issue));
    try {
      return extractJson(content);
    } catch {
      return { explanation: content, fixedCode: extractCode(content) };
    }
  }

  async function optimizeCode(code, lang, issues = []) {
    const content = await chat(buildOptimizePrompt(code, lang, issues));
    return extractCode(content);
  }

  global.LLMClient = {
    isConfigured,
    configError,
    getConfig,
    getStoredConfig,
    saveConfig: saveStoredConfig,
    clearConfig: clearStoredConfig,
    chat,
    reviewCode,
    fixIssue,
    optimizeCode,
  };
})(typeof window !== "undefined" ? window : globalThis);
