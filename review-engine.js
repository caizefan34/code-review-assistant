/**
 * 智能代码审查引擎 — 支持 Python 与 C++
 * 纯静态规则分析，无需外部依赖
 */
(function (global) {
  "use strict";

  const SEVERITY_WEIGHT = { critical: 15, warning: 8, info: 3, suggestion: 1 };
  const CATEGORY_LABELS = {
    security: "安全",
    bug: "缺陷",
    performance: "性能",
    style: "风格",
    "best-practice": "最佳实践",
  };

  /** @typedef {{ id: string, line: number, col?: number, severity: string, category: string, rule: string, message: string, suggestion?: string, snippet?: string }} Issue */

  function stripCommentsAndStrings(line, lang) {
    let result = line;
    if (lang === "python") {
      const hashIdx = result.indexOf("#");
      if (hashIdx >= 0) result = result.slice(0, hashIdx);
    } else {
      result = result.replace(/\/\/.*$/, "");
      result = result.replace(/"([^"\\]|\\.)*"/g, '""');
      result = result.replace(/'([^'\\]|\\.)*'/g, "''");
    }
    return result;
  }

  function makeIssue(rule, lineNum, line, extra = {}) {
    return {
      id: rule.id,
      line: lineNum,
      severity: rule.severity,
      category: rule.category,
      rule: rule.name,
      message: typeof rule.message === "function" ? rule.message(line) : rule.message,
      suggestion: rule.suggestion,
      snippet: line.trim().slice(0, 120),
      ...extra,
    };
  }

  function runRegexRules(code, rules, lang) {
    const lines = code.split("\n");
    /** @type {Issue[]} */
    const issues = [];

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      const stripped = stripCommentsAndStrings(line, lang);

      for (const rule of rules) {
        if (rule.skipComment && stripped.trim() === "") continue;
        if (rule.test instanceof RegExp) {
          if (rule.test.test(stripped)) {
            issues.push(makeIssue(rule, lineNum, line));
          }
        } else if (typeof rule.test === "function") {
          const result = rule.test(stripped, line, lines, idx);
          if (result) {
            issues.push(makeIssue(rule, lineNum, line, typeof result === "object" ? result : {}));
          }
        }
      }
    });

    return issues;
  }

  function runGlobalRules(code, rules, lang) {
    /** @type {Issue[]} */
    const issues = [];
    for (const rule of rules) {
      if (typeof rule.test === "function") {
        const found = rule.test(code, lang);
        if (Array.isArray(found)) issues.push(...found);
      }
    }
    return issues;
  }

  // ─── Python 规则 ───────────────────────────────────────────

  const PYTHON_RULES = [
  // 安全
    {
      id: "py-eval",
      name: "eval() 动态执行",
      category: "security",
      severity: "critical",
      test: /\beval\s*\(/,
      message: "使用 eval() 执行动态代码存在代码注入风险",
      suggestion: "改用 ast.literal_eval() 处理字面量，或使用安全的解析方案",
    },
    {
      id: "py-exec",
      name: "exec() 动态执行",
      category: "security",
      severity: "critical",
      test: /\bexec\s*\(/,
      message: "exec() 可执行任意代码，存在严重安全隐患",
      suggestion: "避免 exec；如必须使用，严格限制输入来源并做白名单校验",
    },
    {
      id: "py-pickle",
      name: "pickle 反序列化",
      category: "security",
      severity: "critical",
      test: /pickle\.loads?\s*\(|cPickle\.loads?\s*\(/,
      message: "pickle 反序列化不可信数据可导致任意代码执行",
      suggestion: "对不可信数据使用 json 等安全格式",
    },
    {
      id: "py-shell-true",
      name: "subprocess shell=True",
      category: "security",
      severity: "critical",
      test: /subprocess\.(call|run|Popen|check_output|check_call)\([^)]*shell\s*=\s*True/,
      message: "shell=True 可能导致命令注入",
      suggestion: "使用 shell=False 并将命令拆分为列表传递",
    },
    {
      id: "py-sql-format",
      name: "SQL 字符串拼接",
      category: "security",
      severity: "critical",
      test: (s) => /(?:execute|cursor\.execute)\s*\(\s*[f"']/.test(s) || /\.format\s*\([^)]*\)\s*$/.test(s) && /SELECT|INSERT|UPDATE|DELETE/i.test(s),
      message: "SQL 语句通过字符串拼接构造，存在 SQL 注入风险",
      suggestion: "使用参数化查询：cursor.execute('SELECT * FROM t WHERE id=?', (id,))",
    },
    {
      id: "py-hardcoded-secret",
      name: "硬编码密钥",
      category: "security",
      severity: "warning",
      test: /(?:password|secret|api_key|apikey|token|private_key)\s*=\s*['"][^'"]{4,}['"]/i,
      message: "检测到可能的硬编码密钥或密码",
      suggestion: "使用环境变量或密钥管理服务（如 os.environ.get）",
    },
    {
      id: "py-yaml-unsafe",
      name: "yaml.load 不安全",
      category: "security",
      severity: "critical",
      test: /yaml\.load\s*\([^)]*\)(?!.*Loader)/,
      message: "yaml.load() 默认不安全，可执行任意 Python 对象",
      suggestion: "改用 yaml.safe_load()",
    },
    {
      id: "py-md5",
      name: "弱哈希 MD5",
      category: "security",
      severity: "warning",
      test: /hashlib\.md5\s*\(/,
      message: "MD5 已不安全，不应用于密码或签名场景",
      suggestion: "密码存储用 bcrypt/argon2；完整性校验用 SHA-256 或更强算法",
    },
  // 缺陷
    {
      id: "py-bare-except",
      name: "裸 except",
      category: "bug",
      severity: "warning",
      test: /^\s*except\s*:\s*$/,
      message: "裸 except 会捕获 SystemExit 和 KeyboardInterrupt",
      suggestion: "捕获具体异常类型，如 except ValueError:",
    },
    {
      id: "py-mutable-default",
      name: "可变默认参数",
      category: "bug",
      severity: "warning",
      test: /def\s+\w+\([^)]*=\s*(\[\]|\{\}|set\(\))/,
      message: "可变对象作为默认参数会在多次调用间共享状态",
      suggestion: "改用 def foo(items=None): items = items or []",
    },
    {
      id: "py-is-none",
      name: "None 比较方式",
      category: "bug",
      severity: "info",
      test: /[^=!]==\s*None|None\s*==/,
      message: "应使用 is / is not 与 None 比较",
      suggestion: "改为 `x is None` 或 `x is not None`",
    },
    {
      id: "py-shadow-builtin",
      name: "覆盖内置名",
      category: "bug",
      severity: "warning",
      test: /^\s*(?:def|class)\s+(list|dict|set|id|type|str|int|float|open|input|print|len|range|map|filter)\s*[\(:]/,
      message: "函数/类名覆盖了 Python 内置名称",
      suggestion: "重命名以避免与内置名冲突",
    },
    {
      id: "py-assert-prod",
      name: "生产环境 assert",
      category: "bug",
      severity: "info",
      test: /^\s*assert\s+/,
      message: "assert 在 python -O 模式下会被移除",
      suggestion: "关键校验改用 if + raise 显式抛出异常",
    },
  // 性能
    {
      id: "py-global-loop",
      name: "循环内重复计算",
      category: "performance",
      severity: "info",
      test: (s, line, lines, idx) => {
        return /^\s*for\s+/.test(s) && /\.keys\(\)|\.values\(\)|\.items\(\)/.test(s) && /len\s*\(/.test(s);
      },
      message: "循环条件中重复调用 len() 或 dict 方法",
      suggestion: "将 len 结果缓存到变量，或直接迭代 dict",
    },
    {
      id: "py-list-comp-range",
      name: "range(len()) 反模式",
      category: "performance",
      severity: "suggestion",
      test: /for\s+\w+\s+in\s+range\s*\(\s*len\s*\(/,
      message: "使用 range(len(x)) 迭代不如直接 enumerate 或 zip",
      suggestion: "改用 for i, item in enumerate(items):",
    },
    {
      id: "py-string-concat-loop",
      name: "循环内字符串拼接",
      category: "performance",
      severity: "warning",
      test: (s, line, lines, idx) => {
        if (!/^\s*for\s+/.test(s) && !/^\s*while\s+/.test(s)) return false;
        for (let i = idx + 1; i < Math.min(idx + 8, lines.length); i++) {
          const inner = stripCommentsAndStrings(lines[i], "python");
          if (/^\s*\w+\s*\+=\s*['"]/.test(inner) || /^\s*\w+\s*=\s*\w+\s*\+/.test(inner)) return true;
          if (/^\s*(def |class |for |while )/.test(inner) && i > idx) break;
        }
        return false;
      },
      message: "循环中使用 += 拼接字符串效率低（O(n²)）",
      suggestion: "收集到 list 后用 ''.join(parts)",
    },
  // 风格 & 最佳实践
    {
      id: "py-wildcard-import",
      name: "通配符导入",
      category: "style",
      severity: "warning",
      test: /from\s+\S+\s+import\s+\*/,
      message: "from module import * 污染命名空间且难以追踪来源",
      suggestion: "显式导入需要的名称",
    },
    {
      id: "py-print-debug",
      name: "print 调试",
      category: "style",
      severity: "suggestion",
      test: /^\s*print\s*\(/,
      message: "检测到 print 语句，可能是遗留调试代码",
      suggestion: "生产代码使用 logging 模块",
    },
    {
      id: "py-todo",
      name: "TODO 标记",
      category: "best-practice",
      severity: "info",
      test: /#\s*(TODO|FIXME|HACK|XXX|BUG)\b/i,
      message: "代码中存在待办标记",
      suggestion: "跟踪并完成 TODO 项或创建 issue",
    },
    {
      id: "py-no-type-hint",
      name: "公共函数缺少类型注解",
      category: "best-practice",
      severity: "suggestion",
      test: (s) => /^def\s+[a-z]\w*\(/.test(s) && !/->/.test(s) && !s.includes("__"),
      message: "公共函数缺少返回类型注解",
      suggestion: "添加类型提示以提高可读性和 IDE 支持",
    },
    {
      id: "py-open-no-with",
      name: "未使用 with 打开文件",
      category: "best-practice",
      severity: "warning",
      test: (s, line, lines, idx) => {
        if (!/=\s*open\s*\(/.test(s) || /with\s+open/.test(s)) return false;
        for (let i = idx + 1; i < Math.min(idx + 15, lines.length); i++) {
          if (/\.close\s*\(\s*\)/.test(lines[i])) return false;
        }
        return true;
      },
      message: "open() 未配合 with 语句，可能导致资源泄漏",
      suggestion: "使用 with open(path) as f: 自动管理文件句柄",
    },
  ];

  const PYTHON_GLOBAL_RULES = [
    {
      id: "py-long-file",
      name: "文件过长",
      category: "best-practice",
      severity: "info",
      test: (code) => {
        const n = code.split("\n").length;
        if (n <= 500) return [];
        return [{
          id: "py-long-file", line: 1, severity: "info", category: "best-practice",
          rule: "文件过长", message: `文件共 ${n} 行，建议拆分为更小的模块`, suggestion: "按职责拆分为多个模块",
        }];
      },
    },
    {
      id: "py-missing-main-guard",
      name: "缺少 main 守卫",
      category: "best-practice",
      severity: "suggestion",
      test: (code) => {
        if (!/\bif\s+__name__\s*==\s*['"]__main__['"]/.test(code) && /^(?:def main|def run)/m.test(code)) {
          return [{
            id: "py-missing-main-guard", line: 1, severity: "suggestion", category: "best-practice",
            rule: "缺少 main 守卫", message: "脚本含 main 函数但缺少 if __name__ == '__main__' 守卫",
            suggestion: "添加 if __name__ == '__main__': main()",
          }];
        }
        return [];
      },
    },
  ];

  // ─── C++ 规则 ──────────────────────────────────────────────

  const CPP_RULES = [
  // 安全
    {
      id: "cpp-gets",
      name: "gets() 禁用函数",
      category: "security",
      severity: "critical",
      test: /\bgets\s*\(/,
      message: "gets() 无法检查缓冲区边界，已被 C11 移除",
      suggestion: "改用 fgets() 或 std::getline()",
    },
    {
      id: "cpp-strcpy",
      name: "strcpy 缓冲区风险",
      category: "security",
      severity: "critical",
      test: /\bstrcpy\s*\(/,
      message: "strcpy 不检查目标缓冲区大小，可能导致缓冲区溢出",
      suggestion: "改用 strncpy 或 std::string",
    },
    {
      id: "cpp-sprintf",
      name: "sprintf 缓冲区风险",
      category: "security",
      severity: "warning",
      test: /\bsprintf\s*\(/,
      message: "sprintf 不限制写入长度",
      suggestion: "改用 snprintf 或 std::format / std::ostringstream",
    },
    {
      id: "cpp-scanf-no-width",
      name: "scanf 无宽度限制",
      category: "security",
      severity: "warning",
      test: /\bscanf\s*\(\s*"[^"]*%s/,
      message: "scanf %s 不限制读取长度，存在溢出风险",
      suggestion: "使用宽度限制如 %99s，或改用 std::cin",
    },
    {
      id: "cpp-system",
      name: "system() 调用",
      category: "security",
      severity: "warning",
      test: /\bsystem\s*\(/,
      message: "system() 执行 shell 命令，存在命令注入风险",
      suggestion: "避免 system；使用安全的 API 替代",
    },
  // 缺陷 & 内存
    {
      id: "cpp-raw-new",
      name: "裸 new 分配",
      category: "bug",
      severity: "warning",
      test: /\bnew\s+(?!std::)/,
      message: "裸 new 需要手动 delete，容易导致内存泄漏",
      suggestion: "使用 std::make_unique 或 std::make_shared",
    },
    {
      id: "cpp-raw-delete",
      name: "裸 delete",
      category: "bug",
      severity: "info",
      test: /\bdelete\s+(?!\[)/,
      message: "手动 delete 需确保异常安全",
      suggestion: "优先使用 RAII 和智能指针",
    },
    {
      id: "cpp-malloc-free",
      name: "C 风格内存管理",
      category: "bug",
      severity: "warning",
      test: /\b(malloc|calloc|realloc|free)\s*\(/,
      message: "C 风格内存管理在 C++ 中容易出错",
      suggestion: "使用 new/delete 的 RAII 封装，或 std::vector/std::string",
    },
    {
      id: "cpp-null-deref",
      name: "可能的空指针解引用",
      category: "bug",
      severity: "warning",
      test: (s) => {
        if (!/->/.test(s)) return false;
        const prev = s.match(/(\w+)\s*->/);
        if (!prev) return false;
        const varName = prev[1];
        return new RegExp(`\\b${varName}\\s*=\\s*nullptr|\\b${varName}\\s*=\\s*NULL|\\b${varName}\\s*=\\s*0\\s*;`).test(s);
      },
      message: "变量可能为 nullptr 但仍被解引用",
      suggestion: "解引用前添加空指针检查",
    },
    {
      id: "cpp-using-enum",
      name: "enum 未指定底层类型",
      category: "bug",
      severity: "suggestion",
      test: /\benum\s+\w+\s*\{/,
      message: "未指定类型的 enum 底层类型实现定义",
      suggestion: "C++11 起使用 enum class Name : uint8_t { ... }",
    },
  // 性能
    {
      id: "cpp-pass-by-value",
      name: "大对象值传递",
      category: "performance",
      severity: "suggestion",
      test: (s) => {
        if (/^\s*(?:void|int|bool|auto|template)/.test(s)) return false;
        return /\(\s*(?:std::)?(?:string|vector|map|set|unordered_map)\s+\w+\s*[,)]/.test(s) &&
               !/const\s+(?:std::)?(?:string|vector|map|set|unordered_map)\s*&/.test(s);
      },
      message: "大型 STL 容器以值传递会产生不必要的拷贝",
      suggestion: "改用 const T& 或 T&& （移动语义）",
    },
    {
      id: "cpp-push-back-loop",
      name: "循环内 push_back 未 reserve",
      category: "performance",
      severity: "info",
      test: (s, line, lines, idx) => {
        if (!/^\s*for\s*\(/.test(s)) return false;
        let hasPush = false;
        for (let i = idx; i < Math.min(idx + 10, lines.length); i++) {
          if (/\.push_back\s*\(/.test(lines[i])) hasPush = true;
          if (/\.reserve\s*\(/.test(lines[i])) return false;
        }
        return hasPush;
      },
      message: "循环 push_back 未预先 reserve，可能多次重新分配",
      suggestion: "在循环前调用 vec.reserve(expected_size)",
    },
    {
      id: "cpp-iostream-sync",
      name: "iostream 同步",
      category: "performance",
      severity: "suggestion",
      test: /std::ios_base::sync_with_stdio\s*\(\s*true\s*\)/,
      message: "启用 iostream 与 C stdio 同步会降低性能",
      suggestion: "竞技编程场景可使用 sync_with_stdio(false)",
    },
  // 风格 & 最佳实践
    {
      id: "cpp-using-namespace-std",
      name: "using namespace std",
      category: "style",
      severity: "warning",
      test: /using\s+namespace\s+std\s*;/,
      message: "在全局作用域 using namespace std 可能导致命名冲突",
      suggestion: "改用 std:: 前缀或 using std::vector 等具体声明",
    },
    {
      id: "cpp-c-cast",
      name: "C 风格强制转换",
      category: "style",
      severity: "warning",
      test: /\(\s*(?:int|char|float|double|long|short|unsigned|void\s*\*)\s*\)/,
      message: "C 风格 cast 不安全且难以搜索",
      suggestion: "使用 static_cast / dynamic_cast / reinterpret_cast",
    },
    {
      id: "cpp-goto",
      name: "goto 语句",
      category: "style",
      severity: "warning",
      test: /\bgoto\s+\w+\s*;/,
      message: "goto 破坏结构化控制流，降低可读性",
      suggestion: "重构为循环、break/continue 或函数提取",
    },
    {
      id: "cpp-magic-number",
      name: "魔法数字",
      category: "style",
      severity: "suggestion",
      test: (s) => {
        if (/^\s*#/.test(s) || /^\s*\/\//.test(s)) return false;
        return /[^.\w](?:[1-9]\d{2,}|\d{4,})[^.\dw]/.test(" " + s + " ");
      },
      message: "代码中出现未命名的大数值常量",
      suggestion: "提取为 const / constexpr 命名常量",
    },
    {
      id: "cpp-printf-debug",
      name: "printf 调试输出",
      category: "style",
      severity: "suggestion",
      test: /\b(?:printf|std::cout\s*<<|cerr\s*<<)/,
      message: "检测到标准输出，可能是调试代码",
      suggestion: "生产环境使用日志框架",
    },
    {
      id: "cpp-todo",
      name: "TODO 标记",
      category: "best-practice",
      severity: "info",
      test: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i,
      message: "代码中存在待办标记",
      suggestion: "跟踪并完成 TODO 项",
    },
    {
      id: "cpp-no-override",
      name: "虚函数缺少 override",
      category: "best-practice",
      severity: "suggestion",
      test: (s) => /^\s*virtual\s+\w+/.test(s) && !/\boverride\b/.test(s),
      message: "重写虚函数建议使用 override 关键字",
      suggestion: "添加 override 以在编译期捕获签名错误",
    },
    {
      id: "cpp-nullptr",
      name: "使用 NULL 而非 nullptr",
      category: "best-practice",
      severity: "suggestion",
      test: /\bNULL\b/,
      message: "C++11 起推荐使用 nullptr 代替 NULL",
      suggestion: "将 NULL 替换为 nullptr",
    },
    {
      id: "cpp-auto-decay",
      name: "auto 拷贝大对象",
      category: "best-practice",
      severity: "info",
      test: /auto\s+\w+\s*=\s*[^;]*(?:\.find|\.at|\[)/,
      message: "auto 可能拷贝容器元素，注意是否需要 const auto&",
      suggestion: "对查找结果使用 const auto& 避免拷贝",
    },
  ];

  const CPP_GLOBAL_RULES = [
    {
      id: "cpp-header-guard",
      name: "头文件缺少 include guard",
      category: "best-practice",
      severity: "info",
      test: (code) => {
        const lines = code.split("\n");
        if (lines.length < 5) return [];
        const hasInclude = lines.some((l) => /#include/.test(l));
        if (!hasInclude) return [];
        if (/#pragma\s+once/.test(code) || /#ifndef\s+\w+/.test(code)) return [];
        return [{
          id: "cpp-header-guard", line: 1, severity: "info", category: "best-practice",
          rule: "头文件缺少 include guard", message: "头文件缺少 #pragma once 或 include guard",
          suggestion: "添加 #pragma once 或 #ifndef/#define/#endif",
        }];
      },
    },
    {
      id: "cpp-long-file",
      name: "文件过长",
      category: "best-practice",
      severity: "info",
      test: (code) => {
        const n = code.split("\n").length;
        if (n <= 800) return [];
        return [{
          id: "cpp-long-file", line: 1, severity: "info", category: "best-practice",
          rule: "文件过长", message: `文件共 ${n} 行，建议拆分`, suggestion: "按类/模块拆分头文件与实现",
        }];
      },
    },
  ];

  // ─── 语言检测 ──────────────────────────────────────────────

  function detectLanguage(code) {
    const pyScore =
      (/\bdef\s+\w+\s*\(/.test(code) ? 3 : 0) +
      (/\bimport\s+\w+/.test(code) ? 2 : 0) +
      (/\bself\b/.test(code) ? 2 : 0) +
      (/\bprint\s*\(/.test(code) ? 1 : 0) +
      (/:\s*$/.test(code.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) || "") ? 2 : 0) +
      (/#.*$/.test(code) ? 1 : 0);

    const cppScore =
      (/#include\s*[<"]/.test(code) ? 4 : 0) +
      (/\bstd::\w+/.test(code) ? 3 : 0) +
      (/\b(?:int|void|bool|auto|template)\s+\w+\s*\([^)]*\)\s*\{/.test(code) ? 2 : 0) +
      (/;\s*$/.test(code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//")) || "") ? 1 : 0) +
      (/\b(?:cout|cin|cerr|endl)\b/.test(code) ? 2 : 0) +
      (/\b(?:class|struct|namespace)\s+\w+/.test(code) ? 2 : 0);

    if (pyScore === 0 && cppScore === 0) return "unknown";
    return pyScore >= cppScore ? "python" : "cpp";
  }

  // ─── 评分 ──────────────────────────────────────────────────

  function computeScore(issues, lineCount) {
    if (lineCount === 0) return 100;
    let penalty = 0;
    for (const issue of issues) {
      penalty += SEVERITY_WEIGHT[issue.severity] || 1;
    }
    const density = penalty / Math.max(lineCount, 1);
    const score = Math.max(0, Math.min(100, Math.round(100 - density * 8)));
    return score;
  }

  function scoreColor(score) {
    if (score >= 80) return "#3fb950";
    if (score >= 60) return "#d29922";
    if (score >= 40) return "#db6d28";
    return "#ff7b72";
  }

  // ─── 主入口 ────────────────────────────────────────────────

  function review(code, language = "auto") {
    const trimmed = code.trim();
    if (!trimmed) {
      return { language: "unknown", issues: [], score: 100, summary: { critical: 0, warning: 0, info: 0, suggestion: 0 } };
    }

    const lang = language === "auto" ? detectLanguage(trimmed) : language;
    const lineCount = trimmed.split("\n").length;

    let issues = [];
    if (lang === "python") {
      issues = [
        ...runRegexRules(trimmed, PYTHON_RULES, "python"),
        ...runGlobalRules(trimmed, PYTHON_GLOBAL_RULES, "python"),
      ];
    } else if (lang === "cpp") {
      issues = [
        ...runRegexRules(trimmed, CPP_RULES, "cpp"),
        ...runGlobalRules(trimmed, CPP_GLOBAL_RULES, "cpp"),
      ];
    } else {
      return {
        language: "unknown",
        issues: [{
          id: "unknown-lang", line: 1, severity: "warning", category: "best-practice",
          rule: "无法识别语言", message: "无法自动识别代码语言，请手动选择 Python 或 C++",
          suggestion: "在工具栏选择正确的语言后重新审查",
        }],
        score: 0,
        summary: { critical: 0, warning: 1, info: 0, suggestion: 0 },
      };
    }

    // 去重（同行同规则）
    const seen = new Set();
    issues = issues.filter((i) => {
      const key = `${i.id}:${i.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    issues.sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2, suggestion: 3 };
      return (sev[a.severity] - sev[b.severity]) || (a.line - b.line);
    });

    const summary = { critical: 0, warning: 0, info: 0, suggestion: 0 };
    for (const i of issues) summary[i.severity] = (summary[i.severity] || 0) + 1;

    return {
      language: lang,
      issues,
      score: computeScore(issues, lineCount),
      lineCount,
      summary,
    };
  }

  function exportReport(result, code) {
    const langLabel = result.language === "python" ? "Python" : result.language === "cpp" ? "C++" : "未知";
    const modeLabel = result.mode === "llm" ? "LLM" : result.mode === "hybrid" ? "混合" : "静态";
    const lines = [
      "═══════════════════════════════════════",
      "       智能代码审查报告",
      "═══════════════════════════════════════",
      `语言: ${langLabel}`,
      `模式: ${modeLabel}`,
      `评分: ${result.score}/100`,
      `行数: ${result.lineCount || code.split("\n").length}`,
      `严重: ${result.summary.critical}  警告: ${result.summary.warning}  提示: ${result.summary.info}  建议: ${result.summary.suggestion}`,
      "",
    ];

    if (result.issues.length === 0) {
      lines.push("✓ 未发现问题，代码质量良好！");
    } else {
      result.issues.forEach((issue, idx) => {
        lines.push(`── 问题 #${idx + 1} ──`);
        lines.push(`[${issue.severity.toUpperCase()}] ${issue.rule} (第 ${issue.line} 行)`);
        lines.push(`分类: ${CATEGORY_LABELS[issue.category] || issue.category}`);
        lines.push(`描述: ${issue.message}`);
        if (issue.suggestion) lines.push(`建议: ${issue.suggestion}`);
        if (issue.snippet) lines.push(`代码: ${issue.snippet}`);
        lines.push("");
      });
    }

    lines.push("═══════════════════════════════════════");
    return lines.join("\n");
  }

  function mergeResults(staticResult, llmIssues) {
    const issues = [...staticResult.issues];
    const seen = new Set(issues.map((i) => `${i.line}:${i.rule}:${i.message.slice(0, 40)}`));

    for (const issue of llmIssues) {
      const key = `${issue.line}:${issue.rule}:${issue.message.slice(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        issues.push(issue);
      }
    }

    issues.sort((a, b) => {
      const sev = { critical: 0, warning: 1, info: 2, suggestion: 3 };
      return (sev[a.severity] - sev[b.severity]) || (a.line - b.line);
    });

    const summary = { critical: 0, warning: 0, info: 0, suggestion: 0 };
    for (const i of issues) summary[i.severity] = (summary[i.severity] || 0) + 1;

    return {
      ...staticResult,
      issues,
      score: computeScore(issues, staticResult.lineCount),
      summary,
      mode: "hybrid",
    };
  }

  global.CodeReviewEngine = {
    review,
    detectLanguage,
    exportReport,
    mergeResults,
    computeScore,
    scoreColor,
    CATEGORY_LABELS,
  };
})(typeof window !== "undefined" ? window : globalThis);
