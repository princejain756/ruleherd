#!/usr/bin/env node
// ruleherd - audit agent instruction files for drift, contradictions, dead refs.
// Zero dependencies. Node >= 18.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSION = "0.1.1";
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
      if (st.isFile() && st.size > 0) addFound(found, p, label, st.mtime);
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
      if (st.isFile() && st.size > 0) addFound(found, p, label, st.mtime);
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
const rel = (root, p) => {
  const r = path.relative(root, p);
  if (r && !r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r)) return r;
  if (!r) return path.basename(p);
  if (p.startsWith(HOME + path.sep)) return "~" + p.slice(HOME.length);
  return p;
};

// fenced code blocks hold examples, not rules. mask them (length-preserving,
// keeps line numbers aligned) for checks that would flag examples as refs.
const stripFences = t => t.replace(/```[\s\S]*?(?:```|$)/g, m => " ".repeat(m.length));

// contradiction topics: [name, regexA label, regexA, regexB label, regexB]
const TOPIC_PAIRS = [
  ["package manager", "npm", /\bnpm (?:run|install|ci|test|publish|exec|i)\b/, "pnpm/yarn/bun", /\b(?:pnpm|yarn|bun) (?:run|install|add|test|dlx|exec|i|remove|update|create)\b/],
  ["test runner", "jest", /\bjest\b/, "vitest/mocha", /\b(?:vitest|mocha)\b/],
  ["indentation", "tabs", /\b(?:indent|use|with)\b.{0,20}\btabs?\b|\btabs?\s+(?:for|as)\s+indent/i, "spaces", /\b(?:indent|use|with)\b.{0,20}\bspaces?\b|\bspaces?\s+(?:for|as)\s+indent/i],
  ["module system", "ESM", /\b(?:esm|es modules|"type"\s*:\s*"module"|import\s+[\w*{}\s,]+\s+from\s+['"])/i, "CommonJS", /\b(?:commonjs|cjs|require\s*\()/i],
  ["formatter", "prettier", /\bprettier\b/i, "biome/eslint-format", /\b(?:biome|eslint --fix|standardjs)\b/i],
];

const POLARITY = [/\bnever\b/i, /\bdon't\b|\bdo not\b/i, /\balways\b/i, /\bmust\b/i, /\bno \w+ing\b/i];
const TOPIC_RE = /\b(commit|push|tests?|delete|edit|merge|rebase|sudo|console\.log|secrets?|api keys?)\b/gi;
const CLAUSE_SPLIT = /[.;]|,\s*(?:and|but)\b/i;

function checkConflicts(files, root) {
  const findings = [];
  for (const [topic, aLabel, aRe, bLabel, bRe] of TOPIC_PAIRS) {
    const aHits = [], bHits = [];
    for (const f of files) {
      f.prose.split("\n").forEach((line, i) => {
        if (aRe.test(line) && !bRe.test(line)) aHits.push({ f, i, line: line.trim() });
        if (bRe.test(line) && !aRe.test(line)) bHits.push({ f, i, line: line.trim() });
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
        if (!POLARITY.some(p => p.test(c))) continue;
        const pos = /\balways\b|\bmust\b/i.test(c);
        const neg = /\bnever\b|\bdon't\b|\bdo not\b|\bno \w+ing\b/i.test(c);
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
    const paras = f.text.split(/\n\s*\n/);
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
const IMPORT_RE = /(?:^|[\s(-])@((?:~|\.{1,2}\/)?[\w.@+\/-]+\.(?:md|mdc|json|jsonc|ya?ml|toml|sh|py|ts|tsx|js|mjs|cjs|txt))\b/gi;

function pathExists(root, fromDir, p) {
  if (/^https?:/.test(p)) return true;
  if (p.startsWith("~/")) return fs.existsSync(path.join(HOME, p.slice(2)));
  if (p.startsWith("/")) return fs.existsSync(p);
  return fs.existsSync(path.resolve(fromDir, p)) || fs.existsSync(path.resolve(root, p));
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
        if (!pathExists(root, dir, p)) {
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
]);

function collectScripts(root) {
  const scripts = new Set();
  for (const f of walk(root, 0)) {
    if (path.basename(f) !== "package.json") continue;
    try {
      const s = JSON.parse(fs.readFileSync(f, "utf8")).scripts || {};
      for (const k of Object.keys(s)) scripts.add(k);
    } catch {}
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
          findings.push({ kind: "DEAD CMD", cmd: m[1], file: rel(root, f.path), line: i + 1 });
        }
      }
      for (const m of line.matchAll(bare)) {
        // bare `pnpm x` runs script x, but builtin subcommands aren't scripts
        if (!PM_BUILTINS.has(m[1]) && !scripts.has(m[1])) {
          findings.push({ kind: "DEAD CMD", cmd: m[1], file: rel(root, f.path), line: i + 1 });
        }
      }
    });
  }
  return findings;
}

// stale tech-version mentions: "react 17" in rules while package.json has ^19
const VERSIONED = ["react", "next", "vue", "svelte", "angular", "tailwindcss", "typescript", "node", "prisma", "zod", "vite"];

function checkStaleVersions(files, root) {
  const installed = new Map(); // name -> Set of majors
  for (const f of walk(root, 0)) {
    if (path.basename(f) !== "package.json") continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(f, "utf8"));
      const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.engines };
      for (const name of VERSIONED) {
        const v = all[name];
        if (!v) continue;
        const m = String(v).match(/\d+/);
        if (!m) continue;
        if (!installed.has(name)) installed.set(name, new Set());
        installed.get(name).add(m[0]);
      }
    } catch {}
  }
  if (!installed.size) return [];
  const alias = { tailwind: "tailwindcss", nodejs: "node" };
  const re = new RegExp(`\\b(${[...VERSIONED, "tailwind", "nodejs"].join("|")})[ -]?v?(\\d{1,2})\\b`, "gi");
  const findings = [];
  const emitted = new Set();
  for (const f of files) {
    f.prose.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        const name = alias[m[1].toLowerCase()] || m[1].toLowerCase();
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
function checkDeadGlobs(files, root) {
  const findings = [];
  const re = /^[ \t]*(?:globs?|applyTo)[ \t]*:[ \t]*(\S.*?)[ \t]*$/gim;
  for (const f of files) {
    if (!/\.(mdc|instructions\.md)$/i.test(f.path)) continue;
    const fm = f.text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    for (const m of fm[1].matchAll(re)) {
      for (const glob of m[1].split(/[,;]/).map(s => s.trim().replace(/^["']|["']$/g, ""))) {
        const prefix = glob.split(/[*{[]/)[0].replace(/\/+$/, "");
        if (!prefix || prefix.length < 2) continue;
        const line = f.text.slice(0, fm.index + 4 + m.index).split("\n").length;
        if (!pathExists(root, path.dirname(f.path), prefix)) {
          findings.push({ kind: "DEAD GLOB", ref: glob, file: rel(root, f.path), line, note: "glob prefix does not exist; rule never loads" });
        }
      }
    }
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
  const files = (opts.user ? discoverUser() : discover(root)).flatMap(f => {
    try {
      const buf = fs.readFileSync(f.path);
      if (buf.includes(0)) return []; // binary
      const text = buf.toString("utf8").replace(/\r\n?/g, "\n");
      return [{ ...f, text, prose: stripFences(text) }];
    } catch { return []; } // unreadable, vanished mid-run, etc.
  });

  const scripts = opts.user ? new Set() : collectScripts(root);
  const findings = [
    ...checkConflicts(files, root),
    ...checkDeadRefs(files, root),
    ...checkDeadCmds(files, root, scripts),
    ...checkDuplicates(files, root),
    ...checkDeadGlobs(files, root),
  ];
  if (!opts.user) findings.push(...checkStaleVersions(files, root));

  const hasAgents = files.some(f => path.basename(f.path) === "AGENTS.md");
  if (files.length && !hasAgents && !opts.user) {
    findings.push({ kind: "MISSING", file: "AGENTS.md", note: "30+ agents read AGENTS.md; only Claude reads CLAUDE.md" });
  }

  const perFile = files.map(f => ({ ...f, tokens: Math.round(f.text.length / 4) }));
  for (const f of perFile) {
    if (f.tokens > 4000) {
      findings.push({ kind: "BLOAT", file: rel(root, f.path), note: `~${f.tokens.toLocaleString()} tokens load into every prompt` });
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
  console.log(`\n${C.bold}RULEHERD v${VERSION}${C.reset} ${C.dim}· ${path.basename(root)} · ${new Date().toISOString().slice(0, 10)}${C.reset}`);
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
      console.log(`  ${c}DEAD CMD${C.reset}  npm run ${f.cmd}`);
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
const r = run(root, opts);

if (opts.json) {
  console.log(JSON.stringify({
    root, score: r.score, grade: r.grade, files: r.files.map(f => rel(root, f.path)),
    totalTokens: r.totalTokens,
    findings: r.findings.map(f => ({ ...f, a: f.a && { file: rel(root, f.a.f.path), line: f.a.i + 1, text: f.a.line }, b: f.b && { file: rel(root, f.b.f.path), line: f.b.i + 1, text: f.b.line } })),
  }, null, 2));
} else {
  printReport(root, r, opts);
}

process.exit(opts.strict && r.findings.length ? 1 : 0);
