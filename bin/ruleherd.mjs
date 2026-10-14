#!/usr/bin/env node
// ruleherd - audit agent instruction files for drift, contradictions, dead refs.
// Zero dependencies. Node >= 18.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSION = "0.1.3";
const HOME = os.homedir();

// ---------- discovery ----------

const ROOT_FILES = [
  "AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md",
  "GEMINI.md", "QWEN.md", ".cursorrules", ".windsurfrules", ".clinerules",
  ".aider.conf.yml", ".github/copilot-instructions.md", "CONVENTIONS.md",
];

const RULE_DIRS = [
  { dir: ".cursor/rules", label: "cursor" },
  { dir: ".windsurf/rules", label: "windsurf" },
  { dir: ".clinerules", label: "cline" },
  { dir: ".agents/rules", label: "agents" },
  { dir: ".github/instructions", label: "copilot" },
];

const USER_FILES = [
  { file: "~/.claude/CLAUDE.md", label: "claude code" },
  { file: "~/AGENTS.md", label: "agents" },
  { file: "~/CLAUDE.md", label: "claude code" },
  { file: "~/GEMINI.md", label: "gemini cli" },
  { file: "~/.gemini/GEMINI.md", label: "gemini cli" },
  { file: "~/.config/devin/AGENTS.md", label: "devin" },
  { file: "~/.codeium/windsurf/memories/global_rules.md", label: "windsurf" },
];

const USER_DIRS = [
  { dir: "~/.agents/rules", label: "agents" },
  { dir: "~/.cursor/rules", label: "cursor" },
  { dir: "~/.claude/rules", label: "claude" },
  { dir: "~/.config/agents/rules", label: "agents" },
];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "out", "coverage"]);

function expandHome(p) {
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function* walk(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory(), isFile = e.isFile();
    if (!isDir && !isFile && e.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory(); isFile = st.isFile();
      } catch { continue; }
    }
    if (isDir) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (depth < 3) yield* walk(full, depth + 1);
    } else if (isFile) {
      yield full;
    }
  }
}

function addFound(found, p, label, mtime) {
  let real;
  try { real = fs.realpathSync(p); } catch { real = p; }
  if (found.has(real)) return; // symlink aliases are one file, not a duplicate
  found.set(real, { path: p, label, mtime });
}

function discover(root) {
  const found = new Map();
  const add = (p, label) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size < 5_000_000) addFound(found, p, label, st.mtime);
    } catch {}
  };

  for (const rel of ROOT_FILES) add(path.join(root, rel), rel);

  for (const { dir, label } of RULE_DIRS) {
    const abs = path.join(root, dir);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch { continue; }
    for (const f of walk(abs, 0)) add(f, label);
  }

  // nested copies of the big-name files up to depth 3
  const names = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  for (const f of walk(root, 0)) {
    const base = path.basename(f);
    if (names.has(base)) add(f, base);
  }
  return [...found.values()];
}

function discoverUser() {
  const found = new Map();
  const add = (p, label) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size < 5_000_000) addFound(found, p, label, st.mtime);
    } catch {}
  };
  for (const { file, label } of USER_FILES) add(expandHome(file), label);
  for (const { dir, label } of USER_DIRS) {
    const abs = expandHome(dir);
    try {
      if (!fs.statSync(abs).isDirectory()) continue;
    } catch { continue; }
    for (const f of walk(abs, 0)) add(f, label);
  }
  return [...found.values()];
}

// ---------- checks ----------

// repo-relative when inside root, ~/... when under HOME but outside root,
// absolute otherwise.
const toPosix = p => p.replaceAll("\\", "/");
const rel = (root, p) => {
  const r = path.relative(root, p);
  if (r && !r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
    return toPosix(root === HOME ? "~/" + r : r);
  if (!r) return path.basename(p);
  if (p.startsWith(HOME + path.sep)) return toPosix("~" + p.slice(HOME.length));
  return toPosix(p);
};

// fenced code blocks + yaml frontmatter hold examples/metadata, not rules.
// mask them (newline-preserving, keeps line numbers aligned) so checks don't
// flag examples or frontmatter descriptions as refs or polarity statements.
const maskNewlines = m => m.replace(/[^\n]/g, " ");
// fences anchored to line start so a ``` inside a code block's example text
// can't prematurely close the mask.
const stripFences = t => t.replace(/^ {0,3}```[^\n]*\n[\s\S]*?(?:^ {0,3}```[ \t]*(?:\n|(?![\s\S]))|(?![\s\S]))/gm, maskNewlines);
// requires a real closing --- line: an unclosed marker or top-of-file hrule
// must not mask the whole file.
const FM_RE = /^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/;
const stripFrontmatter = t => t.replace(FM_RE, maskNewlines);

// contradiction topics: [name, regexA label, regexA, regexB label, regexB]
const TOPIC_PAIRS = [
  ["package manager", "npm", /\bnpm (?:run|install|ci|test|publish|exec|i)\b/i, "pnpm/yarn/bun", /\b(?:pnpm|yarn|bun) (?:run|install|add|test|dlx|exec|i|remove|update|create)\b/i],
  ["test runner", "jest", /\bjest\b/i, "vitest/mocha", /\b(?:vitest|mocha)\b/i],
  ["indentation", "tabs", /\bindent\w*[^.\n]{0,30}\btabs?\b|\btabs?\b[^.\n]{0,30}\bindent\w*/i, "spaces", /\bindent\w*[^.\n]{0,30}\bspaces?\b|\bspaces?\b[^.\n]{0,30}\bindent\w*/i],
  ["module system", "ESM", /\b(?:esm|es modules|"type"\s*:\s*"module"|import\s+[\w*{}\s,]+\s+from\s+['"])/i, "CommonJS", /\b(?:commonjs|cjs|require\s*\()/i],
  ["formatter", "prettier", /\bprettier\b/i, "biome/eslint-format", /\b(?:biome|eslint --fix|standardjs)\b/i],
];

// "don't use X" is not a stance for X; negated clauses don't conflict.
// "instead of X" is stripped, not negated: "use pnpm instead of npm" keeps
// its positive (pnpm) stance.
const NEGATED = /\b(?:never|don't|do not|avoid|no)\b/i;
const INSTEAD_TAIL = /\b(?:instead of|rather than)\s+[^.,;\n]+/i;
const TOPIC_RE = /\b(commit|push|delete|merge|rebase|sudo|console\.log|secrets?|api keys?)\b/gi;
// clause boundary: sentence-ending period (lookahead keeps console.log and
// v20.11 intact), semicolon, ", and"/", but". bare periods stay.
const CLAUSE_SPLIT = /\.(?=\s|$)|;|,\s*(?:and|but)\b/i;

function checkConflicts(files, root) {
  const findings = [];
  for (const [topic, aLabel, aRe, bLabel, bRe] of TOPIC_PAIRS) {
    const aHits = [], bHits = [];
    for (const f of files) {
      f.prose.split("\n").forEach((line, i) => {
        // per-clause: "use pnpm instead of npm" keeps the positive half alive
        for (const raw of line.split(CLAUSE_SPLIT)) {
          const clause = raw.replace(INSTEAD_TAIL, "");
          if (NEGATED.test(clause)) continue;
          if (aRe.test(clause) && !bRe.test(clause)) aHits.push({ f, i, line: line.trim() });
          if (bRe.test(clause) && !aRe.test(clause)) bHits.push({ f, i, line: line.trim() });
        }
      });
    }
    // a real conflict needs the two sides in different files
    const pair = aHits.flatMap(a => bHits.map(b => [a, b])).find(([a, b]) => a.f.path !== b.f.path);
    if (pair) {
      findings.push({ kind: "CONFLICT", topic, a: pair[0], b: pair[1], aLabel, bLabel });
    }
  }

  // never/always polarity on shared topics, per clause
  const emitted = new Set();
  const perFile = files.map(f => {
    const entries = [];
    f.prose.split("\n").forEach((line, i) => {
      for (const clause of line.split(CLAUSE_SPLIT)) {
        const c = clause.trim();
        const neg = /\bnever\b|\bdon't\b|\bdo not\b|\bno \w+ing\b|\bmustn'?t\b|\bmust not\b|\bshouldn'?t\b|\bshould not\b|\bcan'?t\b|\bcannot\b|\bwon'?t\b/i.test(c);
        const pos = /\balways\b|\bmust\b(?!\s*not)/i.test(c);
        if (pos === neg) continue;
        for (const m of c.matchAll(TOPIC_RE)) {
          const topic = m[1].toLowerCase().replace(/s$/, "");
          entries.push({ topic, pos, i, line: c });
        }
      }
    });
    return { f, entries };
  });
  for (let i = 0; i < perFile.length; i++) {
    for (let j = i + 1; j < perFile.length; j++) {
      for (const a of perFile[i].entries) {
        for (const b of perFile[j].entries) {
          if (a.topic !== b.topic || a.pos === b.pos) continue;
          const key = perFile[i].f.path + "|" + perFile[j].f.path + "|" + a.topic;
          if (emitted.has(key)) continue;
          emitted.add(key);
          findings.push({
            kind: "CONFLICT", topic: a.topic + " policy",
            a: { f: perFile[i].f, i: a.i, line: a.line },
            b: { f: perFile[j].f, i: b.i, line: b.line },
            aLabel: "", bLabel: "",
          });
        }
      }
    }
  }
  return findings;
}

function normalizeBlock(t) {
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

function checkDuplicates(files, root) {
  const seen = new Map(); // normalized block -> {files:Set, len}
  for (const f of files) {
    const paras = f.prose.split(/\n\s*\n/);
    for (const p of paras) {
      const n = normalizeBlock(p);
      if (n.length < 150) continue;
      if (!seen.has(n)) seen.set(n, { files: new Set(), len: n.length });
      seen.get(n).files.add(f.path);
    }
  }
  const findings = [];
  for (const [, v] of seen) {
    if (v.files.size > 1) {
      findings.push({ kind: "DUPLICATE", len: v.len, files: [...v.files].map(p => rel(root, p)) });
    }
  }
  return findings;
}

// backticked paths: known file extension anywhere, or explicit ./ ../ ~/ prefix.
// bare slash-words without an extension (model ids, slash commands) are skipped.
const PATH_RE = /`((?:~|\.{1,2})\/[\w.@+\/-]+|[\w.@+][\w.@+\/-]*\.(?:md|mdc|json|jsonc|ya?ml|toml|sh|py|ts|tsx|js|mjs|cjs|txt|cfg|ini|rb|go|rs))`/g;
// @file imports (claude code style). requires a file extension so @scope/pkg
// package names in prose don't match.
const IMPORT_RE = /(?:^|[\s(`-])@((?:~|\.{1,2}\/)?[\w.@+\/-]+\.(?:md|mdc|json|jsonc|ya?ml|toml|sh|py|ts|tsx|js|mjs|cjs|txt))\b/gi;

function pathExists(root, fromDir, p) {
  if (/^https?:/.test(p)) return true;
  if (p.startsWith("~/")) return fs.existsSync(path.join(HOME, p.slice(2)));
  if (p.startsWith("/")) return fs.existsSync(p);
  return fs.existsSync(path.resolve(fromDir, p)) || fs.existsSync(path.resolve(root, p))
    || fs.existsSync(path.resolve(root, "node_modules", p)); // @scope/pkg.js subpaths resolve here
}

// bare filenames like `index.ts` in prose are usually examples, not refs.
// flag them only when they're one of the canonical project files.
const KNOWN_FILES = new Set([
  "README.md", "LICENSE", "Makefile", "CONTRIBUTING.md", "CHANGELOG.md",
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
  "tsconfig.json", "Cargo.toml", "pyproject.toml", "go.mod", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "compose.yml",
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules",
]);
const EXAMPLE_DIRS = new Set(["foo", "bar", "baz", "qux", "path", "your-project", "my-project", "my-app", "example", "examples"]);

function checkDeadRefs(files, root) {
  const findings = [];
  for (const f of files) {
    const dir = path.dirname(f.path);
    f.prose.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(PATH_RE)) {
        const p = m[1];
        const firstSeg = p.replace(/^(~|\.{1,2})\//, "").split("/")[0];
        if (firstSeg === "node_modules" || EXAMPLE_DIRS.has(firstSeg)) continue;
        if (/^v?\d+\.\d+/.test(p)) continue;
        const hasSlash = /^(~|\.{1,2})\//.test(p) || p.includes("/");
        if (!hasSlash && !KNOWN_FILES.has(p)) continue;
        if (!pathExists(root, dir, p)) {
          findings.push({ kind: "DEAD REF", ref: p, file: rel(root, f.path), line: i + 1 });
        }
      }
      for (const m of line.matchAll(IMPORT_RE)) {
        const p = m[1];
        const firstSeg = p.replace(/^(~|\.{1,2})\//, "").split("/")[0];
        if (EXAMPLE_DIRS.has(firstSeg)) continue;
        // `p` drops the @; also probe node_modules/@scope/... for npm subpaths
        if (!pathExists(root, dir, p) && !pathExists(root, dir, "@" + p)) {
          findings.push({ kind: "DEAD REF", ref: "@" + p, file: rel(root, f.path), line: i + 1 });
        }
      }
    });
  }
  return findings;
}

const PM_BUILTINS = new Set([
  "install", "add", "remove", "rm", "uninstall", "dlx", "exec", "init",
  "create", "publish", "cache", "config", "why", "list", "ls", "outdated",
  "update", "upgrade", "link", "unlink", "audit", "pack", "info", "help",
  "version", "run", "-r", "--recursive", "import", "rebuild", "prune",
  "test", "t", "start", "stop", "restart", "ci", "env", "store", "patch",
  "patch-commit", "dedupe", "find-dupes", "workspaces", "workspace", "bin",
  "dir", "root", "doctor", "fetch", "licenses", "login", "logout",
  "whoami", "setup", "pkg", "build", "x", "pm", "repl", "up", "set",
  "deploy", "approve-builds", "self-update",
]);

// walk once, hand the parsed package.jsons to every check that needs them.
function collectPkgs(root) {
  const pkgs = [];
  for (const f of walk(root, 0)) {
    if (path.basename(f) !== "package.json") continue;
    try { pkgs.push(JSON.parse(fs.readFileSync(f, "utf8"))); } catch {}
  }
  return pkgs;
}

function collectScripts(pkgs) {
  const scripts = new Set();
  for (const pkg of pkgs) {
    for (const k of Object.keys(pkg.scripts || {})) scripts.add(k);
  }
  return scripts;
}

function checkDeadCmds(files, root, scripts) {
  if (!scripts.size) return [];
  const findings = [];
  const explicit = /`(?:npm run|pnpm run|yarn run|bun run) ([\w:.-]+)`/g;
  const bare = /`(?:pnpm|yarn|bun) ([\w:.-]+)`/g;
  for (const f of files) {
    f.prose.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(explicit)) {
        if (!scripts.has(m[1])) {
          findings.push({ kind: "DEAD CMD", cmd: m[1], raw: m[0].replaceAll("`", ""), file: rel(root, f.path), line: i + 1 });
        }
      }
      for (const m of line.matchAll(bare)) {
        // bare `pnpm x` runs script x, but builtin subcommands aren't
        // scripts; neither are flags (`pnpm -v`) or file args (`bun seed.ts`)
        if (m[1].startsWith("-") || /\.(?:[cm]?[jt]sx?|sh|py|rb)$/.test(m[1])) continue;
        if (!PM_BUILTINS.has(m[1]) && !scripts.has(m[1])) {
          findings.push({ kind: "DEAD CMD", cmd: m[1], raw: m[0].replaceAll("`", ""), file: rel(root, f.path), line: i + 1 });
        }
      }
    });
  }
  return findings;
}

// stale tech-version mentions: "react 17" in rules while package.json has ^19
const VERSIONED = ["react", "next", "vue", "svelte", "angular", "tailwindcss", "typescript", "node", "prisma", "zod", "vite"];

// dependency specifiers that carry no parseable semver (git urls, workspace
// links, catalogs) or that should not be read as version mentions.
const NONSEMVER_DEP = /^(?:file|link|portal|catalog|workspace|npm:|git|github:|https?:)/i;
// count nouns after a version-looking number ("the next 2 steps", "react 10
// times") make it prose, not a version mention.
const COUNT_NOUN = /^\s+(?:items?|steps?|lines?|files?|times?|days?|hours?|minutes|seconds|weeks?|months?|years?|sections?|chapters?|parts?|phases?|stages?|commits?)\b/i;

function checkStaleVersions(files, pkgs) {
  const installed = new Map(); // name -> Set of majors
  for (const pkg of pkgs) {
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.engines };
    for (const name of VERSIONED) {
      const v = all[name];
      if (!v || NONSEMVER_DEP.test(String(v).trim())) continue;
      // drop exclusive upper bounds first, then take every remaining major:
      // ">=18 <20" -> {18}; "^18 || ^20" -> {18,20}; "^19.0.0-rc-1" -> {19}
      const spec = String(v).replace(/<\s*\d+(?:\.\d+)*/g, "");
      for (const m of spec.matchAll(/(?:^|[~^>=|\s])v?(\d+)(?=\.|\s|\||$)/g)) {
        if (!installed.has(name)) installed.set(name, new Set());
        installed.get(name).add(m[1]);
      }
    }
  }
  if (!installed.size) return [];
  const alias = { tailwind: "tailwindcss", nodejs: "node" };
  const re = new RegExp(`\\b(${[...VERSIONED, "tailwind", "nodejs"].join("|")})(?:\\.js)?[ -]?v?(\\d{1,2})\\b`, "gi");
  const findings = [];
  const emitted = new Set();
  for (const f of files) {
    f.prose.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        const name = alias[m[1].toLowerCase()] || m[1].toLowerCase();
        // lowercase "next" is usually the English word; require Next, next.js, or next vN
        if (name === "next" && !/^(Next|next\.js|next[ -]v)/.test(m[0])) continue;
        if (COUNT_NOUN.test(line.slice(m.index + m[0].length))) continue;
        const majors = installed.get(name);
        if (!majors || majors.has(m[2])) continue;
        const key = name + "|" + m[2] + "|" + f.path;
        if (emitted.has(key)) continue;
        emitted.add(key);
        findings.push({
          kind: "STALE", ref: `${m[1]} ${m[2]}`,
          file: rel(root, f.path), line: i + 1,
          note: `package.json has ${name} ${[...majors].join("/")}`,
        });
      }
    });
  }
  return findings;
}

// cursor/copilot scoped rules whose glob prefix points at a deleted directory
// silently never load. check the static prefix of each glob.
// split a glob list on top-level commas/semicolons only — commas inside
// brace expansions ({ts,tsx}) must not split.
const splitGlobs = s => {
  const out = [];
  let cur = "", depth = 0;
  for (const ch of s) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

function checkDeadGlobs(files, root) {
  const findings = [];
  const inline = /^[ \t]*(?:globs?|applyTo)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim;
  const listKey = /^[ \t]*(?:globs?|applyTo)[ \t]*(?::[ \t]*(?:#.*)?)$/;
  const clean = s => s.trim().replace(/\s+#.*$/, "").replace(/^\[|\]$/g, "").trim().replace(/^["']|["']$/g, "");
  const check = (f, glob, line) => {
    if (!glob || glob.startsWith("#") || glob.startsWith("!")) return; // !x is an exclusion glob
    // leading "/" is repo-root-relative intent, not the OS root
    const g = glob.replace(/^\/+/, "");
    // static prefix = everything before the first wildcard, trimmed back to
    // the last complete path segment (src/Button*.tsx -> src)
    const wild = g.search(/[*?{[]/);
    let prefix;
    if (wild === -1) prefix = g.replace(/\/+$/, "");
    else {
      const seg = g.slice(0, wild);
      prefix = seg.includes("/") ? seg.slice(0, seg.lastIndexOf("/")) : "";
    }
    if (!prefix || prefix === ".") return;
    // cursor/copilot globs are workspace-root-relative, not rule-dir-relative
    if (!fs.existsSync(path.resolve(root, prefix))) {
      findings.push({ kind: "DEAD GLOB", ref: glob, file: rel(root, f.path), line, note: "glob prefix does not exist; rule never loads" });
    }
  };
  for (const f of files) {
    if (!/\.(mdc|instructions\.md)$/i.test(f.path)) continue;
    const fm = f.text.match(FM_RE);
    if (!fm) continue;
    const fmBody = fm[0].replace(/^---[ \t]*\n/, "").replace(/---[ \t]*(?:\n|$)$/, "");
    // inline form: "globs: src/**" or "globs: [a/**, b/**]". file line =
    // fm line + 1, since the body starts after the opening "---" line.
    for (const m of fmBody.matchAll(inline)) {
      const line = fmBody.slice(0, m.index).split("\n").length + 1;
      for (const glob of splitGlobs(clean(m[1])).map(clean)) check(f, glob, line);
    }
    // yaml list form: "globs:" followed by "- *.x" lines
    const fmLines = fmBody.split("\n");
    fmLines.forEach((l, li) => {
      if (!listKey.test(l)) return;
      for (let k = li + 1; k < fmLines.length; k++) {
        const item = fmLines[k].match(/^[ \t]*-[ \t]*(.+)$/);
        if (!item) {
          if (/^[ \t]*(#|$)/.test(fmLines[k])) continue; // comments/blanks don't end the list
          break;
        }
        for (const glob of splitGlobs(clean(item[1])).map(clean)) check(f, glob, k + 2);
      }
    });
  }
  return findings;
}

// ---------- report ----------

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
};
const KIND_COLOR = { CONFLICT: C.red, "DEAD REF": C.yellow, "DEAD CMD": C.yellow, DUPLICATE: C.magenta, MISSING: C.blue, BLOAT: C.yellow, STALE: C.yellow, "DEAD GLOB": C.yellow };

function grade(score) {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

function run(root, opts) {
  // in --user mode the effective root is HOME, so output is identical no
  // matter which directory the tool was invoked from.
  const scanRoot = opts.user ? HOME : root;
  const files = (opts.user ? discoverUser() : discover(root)).flatMap(f => {
    try {
      const buf = fs.readFileSync(f.path);
      if (buf.includes(0)) return []; // binary
      const text = buf.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      return [{ ...f, text, prose: stripFences(stripFrontmatter(text)) }];
    } catch { return []; } // unreadable, vanished mid-run, etc.
  });

  const pkgs = opts.user ? [] : collectPkgs(root);
  const findings = [
    ...checkConflicts(files, scanRoot),
    ...checkDeadRefs(files, scanRoot),
    ...checkDeadCmds(files, scanRoot, collectScripts(pkgs)),
    ...checkDuplicates(files, scanRoot),
    ...checkDeadGlobs(files, scanRoot),
  ];
  if (!opts.user) findings.push(...checkStaleVersions(files, pkgs));

  const hasAgents = files.some(f => path.basename(f.path) === "AGENTS.md");
  if (files.length && !hasAgents && !opts.user) {
    findings.push({ kind: "MISSING", file: "AGENTS.md", note: "30+ agents read AGENTS.md; only Claude reads CLAUDE.md" });
  }

  const perFile = files.map(f => ({ ...f, tokens: Math.round(f.text.length / 4) }));
  for (const f of perFile) {
    if (f.tokens > 4000) {
      findings.push({ kind: "BLOAT", file: rel(scanRoot, f.path), note: `~${f.tokens.toLocaleString()} tokens load into every prompt` });
    }
  }
  const totalTokens = perFile.reduce((s, f) => s + f.tokens, 0);

  let score = 100;
  const count = k => findings.filter(x => x.kind === k).length;
  score -= Math.min(50, count("CONFLICT") * 20);
  score -= Math.min(24, count("DEAD REF") * 6);
  score -= Math.min(20, count("DEAD CMD") * 8);
  score -= Math.min(15, count("DUPLICATE") * 5);
  score -= Math.min(10, count("STALE") * 4);
  score -= Math.min(10, count("DEAD GLOB") * 5);
  score -= Math.min(10, count("BLOAT") * 5);
  score -= Math.min(5, count("MISSING") * 5);
  score = Math.max(0, score);

  return { files: perFile, findings, totalTokens, score, grade: grade(score) };
}

function printReport(root, r, opts) {
  const bar = "═".repeat(58);
  console.log(`\n${C.bold}RULEHERD v${VERSION}${C.reset} ${C.dim}· ${root === HOME ? "~ (global config)" : path.basename(root)} · ${new Date().toISOString().slice(0, 10)}${C.reset}`);
  console.log(C.dim + bar + C.reset);
  const g = r.grade;
  const gc = g === "A" || g === "B" ? C.green : g === "C" || g === "D" ? C.yellow : C.red;
  console.log(`${C.bold}GRADE: ${gc}${g}${C.reset}${C.bold} (${r.score}/100)${C.reset}\n`);

  if (!r.files.length) {
    console.log("no agent instruction files found.");
    console.log(`looked for CLAUDE.md, AGENTS.md, .cursor/rules/, .windsurfrules, copilot-instructions...`);
    return;
  }

  console.log(`${r.files.length} instruction file${r.files.length > 1 ? "s" : ""} · ~${r.totalTokens.toLocaleString()} tokens of agent context`);
  for (const f of r.files.sort((a, b) => b.tokens - a.tokens)) {
    console.log(`  ${rel(root, f.path).padEnd(46)} ${String(f.tokens).padStart(6)} tok  ${C.dim}${f.label}${C.reset}`);
  }
  console.log();

  if (!r.findings.length) {
    console.log(`${C.green}no drift found. your files agree with each other and with the repo.${C.reset}`);
    return;
  }

  console.log(C.bold + "FINDINGS" + C.reset);
  for (const f of r.findings) {
    const c = KIND_COLOR[f.kind] || C.reset;
    if (f.kind === "CONFLICT") {
      console.log(`  ${c}CONFLICT${C.reset}  ${f.topic}`);
      console.log(`          ${rel(root, f.a.f.path)}:${f.a.i + 1}  ${C.dim}"${f.a.line.slice(0, 70)}"${C.reset}`);
      console.log(`          ${rel(root, f.b.f.path)}:${f.b.i + 1}  ${C.dim}"${f.b.line.slice(0, 70)}"${C.reset}`);
    } else if (f.kind === "DEAD REF") {
      console.log(`  ${c}DEAD REF${C.reset}  ${f.ref}`);
      console.log(`          ${f.file}:${f.line}  ${C.dim}file does not exist${C.reset}`);
    } else if (f.kind === "DEAD CMD") {
      console.log(`  ${c}DEAD CMD${C.reset}  ${f.raw || "npm run " + f.cmd}`);
      console.log(`          ${f.file}:${f.line}  ${C.dim}no "${f.cmd}" script in any package.json${C.reset}`);
    } else if (f.kind === "DUPLICATE") {
      console.log(`  ${c}DUPLICATE${C.reset} ~${f.len}-char block in ${f.files.length} files`);
      for (const p of f.files) console.log(`          ${C.dim}${p}${C.reset}`);
    } else if (f.kind === "MISSING") {
      console.log(`  ${c}MISSING${C.reset}   ${f.file}  ${C.dim}${f.note}${C.reset}`);
    } else if (f.kind === "BLOAT") {
      console.log(`  ${c}BLOAT${C.reset}     ${f.file}  ${C.dim}${f.note}${C.reset}`);
    } else if (f.kind === "STALE") {
      console.log(`  ${c}STALE${C.reset}     ${f.ref} in ${f.file}:${f.line}`);
      console.log(`          ${C.dim}${f.note}${C.reset}`);
    } else if (f.kind === "DEAD GLOB") {
      console.log(`  ${c}DEAD GLOB${C.reset} ${f.ref} in ${f.file}:${f.line}`);
      console.log(`          ${C.dim}${f.note}${C.reset}`);
    }
  }
  console.log(`\n${C.dim}fix the conflicts first. dead refs and dupes are why your agents disagree.${C.reset}\n`);
}

// ---------- cli ----------

const args = process.argv.slice(2);
const opts = {
  user: args.includes("--user") || args.includes("-u"),
  json: args.includes("--json"),
  help: args.includes("--help") || args.includes("-h"),
  strict: args.includes("--strict"),
};
const dirArg = args.find(a => !a.startsWith("-"));

if (opts.help) {
  console.log(`ruleherd ${VERSION} - audit agent instruction files for drift

usage:
  ruleherd [dir]      audit a repo (default: cwd)
  ruleherd --user     audit your global config files (~/.claude, ~/.cursor, ...)
  ruleherd --json     machine-readable output
  ruleherd --strict   exit 1 if any finding (for CI)

finds: contradictions between files, dead file refs, commands that don't
exist in package.json, stale version mentions, dead rule globs, blocks
copy-pasted across files, missing AGENTS.md.`);
  process.exit(0);
}

const root = path.resolve(dirArg || ".");
const displayRoot = opts.user ? HOME : root;
const r = run(root, opts);

if (opts.json) {
  console.log(JSON.stringify({
    root: displayRoot, score: r.score, grade: r.grade, files: r.files.map(f => rel(displayRoot, f.path)),
    totalTokens: r.totalTokens,
    findings: r.findings.map(f => ({ ...f, aLabel: f.aLabel || undefined, bLabel: f.bLabel || undefined, a: f.a && { file: rel(displayRoot, f.a.f.path), line: f.a.i + 1, text: f.a.line }, b: f.b && { file: rel(displayRoot, f.b.f.path), line: f.b.i + 1, text: f.b.line } })),
  }, null, 2));
} else {
  printReport(displayRoot, r, opts);
}

process.exit(opts.strict && r.findings.length ? 1 : 0);
