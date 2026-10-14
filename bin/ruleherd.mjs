#!/usr/bin/env node
// ruleherd - audit agent instruction files for drift, contradictions, dead refs.
// Zero dependencies. Node >= 18.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VERSION = "0.1.0";
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
  { dir: "rules", label: "rules" },
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

function expandHome(p) {
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

function* walk(dir, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "dist", "build", ".next", "vendor"].includes(e.name)) continue;
      if (depth < 3) yield* walk(full, depth + 1);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

function discover(root) {
  const found = new Map();
  const add = (p, label) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) found.set(p, { path: p, label, mtime: st.mtime });
    } catch {}
  };

  for (const rel of ROOT_FILES) add(path.join(root, rel), rel);

  for (const { dir, label } of RULE_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, 0)) add(f, label);
  }

  // nested copies of the big-name files up to depth 3
  const names = new Set(["CLAUDE.md", "AGENTS.md", "GEMINI.md"]);
  for (const f of walk(root, 0)) {
    const base = path.basename(f);
    if (names.has(base) && !found.has(f)) add(f, base);
  }
  return [...found.values()];
}

function discoverUser() {
  const found = new Map();
  const add = (p, label) => {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0) found.set(p, { path: p, label, mtime: st.mtime });
    } catch {}
  };
  for (const { file, label } of USER_FILES) add(expandHome(file), label);
  for (const { dir, label } of USER_DIRS) {
    const abs = expandHome(dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, 0)) add(f, label);
  }
  return [...found.values()];
}

// ---------- checks ----------

const rel = (root, p) => {
  if (p.startsWith(HOME + path.sep)) return "~" + p.slice(HOME.length);
  const r = path.relative(root, p);
  return r.startsWith("..") ? p : r || p;
};

// contradiction topics: [name, regexA label, regexA, regexB label, regexB]
const TOPIC_PAIRS = [
  ["package manager", "npm", /\bnpm (run|install|ci|test|publish|exec|i )\b/, "pnpm/yarn/bun", /\b(pnpm|yarn|bun) (run|install|add|test|dlx|exec)?\b/],
  ["test runner", "jest", /\bjest\b/, "vitest/mocha", /\b(vitest|mocha)\b/],
  ["indentation", "tabs", /\b(indent|use|with) .{0,20}\btabs?\b|\btabs? (for|as) indent/i, "spaces", /\b(indent|use|with) .{0,20}\bspaces?\b|\bspaces? (for|as) indent/i],
  ["module system", "ESM", /\b(esm|es modules|type.{0,4}module|import .{0,30}from)\b/i, "CommonJS", /\b(commonjs|cjs|require\()\b/i],
  ["formatter", "prettier", /\bprettier\b/i, "biome/eslint-format", /\b(biome|eslint --fix|standardjs)\b/i],
];

const POLARITY = [/\bnever\b/i, /\bdon't\b|\bdo not\b/i, /\balways\b/i, /\bmust\b/i, /\bno \w+ing\b/i];
const POLARITY_TOPICS = /\b(commit|push|test|delete|edit|merge|rebase|sudo|console\.log|secrets?|api keys?)\b/i;

function checkConflicts(files, root) {
  const findings = [];
  for (const [topic, aLabel, aRe, bLabel, bRe] of TOPIC_PAIRS) {
    const aHits = [], bHits = [];
    for (const f of files) {
      const lines = f.text.split("\n");
      lines.forEach((line, i) => {
        if (aRe.test(line) && !bRe.test(line)) aHits.push({ f, i, line: line.trim() });
        if (bRe.test(line) && !aRe.test(line)) bHits.push({ f, i, line: line.trim() });
      });
    }
    if (aHits.length && bHits.length) {
      // only a conflict if the sides come from different files
      const aFiles = new Set(aHits.map(h => h.f.path));
      const bFiles = new Set(bHits.map(h => h.f.path));
      const conflictFiles = [...aFiles].some(p => bFiles.has(p)) ? false : true;
      if (conflictFiles || [...aFiles].some(p => !bFiles.has(p))) {
        findings.push({
          kind: "CONFLICT", topic,
          a: aHits[0], b: bHits[0],
          aLabel, bLabel,
        });
      }
    }
  }
  // polarity on shared topics across files
  const perFile = files.map(f => ({
    f,
    polarityLines: f.text.split("\n").map((line, i) => ({ i, line: line.trim() }))
      .filter(({ line }) => POLARITY.some(p => p.test(line)) && POLARITY_TOPICS.test(line)),
  }));
  for (let i = 0; i < perFile.length; i++) {
    for (let j = i + 1; j < perFile.length; j++) {
      const topicsOf = line => new Set([...line.matchAll(new RegExp(POLARITY_TOPICS.source, "gi"))].map(m => m[1].toLowerCase()));
      for (const a of perFile[i].polarityLines) {
        for (const b of perFile[j].polarityLines) {
          const shared = [...topicsOf(a.line)].filter(t => topicsOf(b.line).has(t));
          if (!shared.length) continue;
          const posA = /\balways\b|\bmust\b/i.test(a.line);
          const negA = /\bnever\b|\bdon't\b|\bdo not\b|\bno \w+ing\b/i.test(a.line);
          const posB = /\balways\b|\bmust\b/i.test(b.line);
          const negB = /\bnever\b|\bdon't\b|\bdo not\b|\bno \w+ing\b/i.test(b.line);
          if ((posA && negB) || (negA && posB)) {
            findings.push({ kind: "CONFLICT", topic: shared[0] + " policy", a: { f: perFile[i].f, ...a }, b: { f: perFile[j].f, ...b }, aLabel: "", bLabel: "" });
          }
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
const IMPORT_RE = /^@([\w./~-]+\.[a-z]+)/gim;

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
    const lines = f.text.split("\n");
    lines.forEach((line, i) => {
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
        if (!pathExists(root, dir, p)) {
          findings.push({ kind: "DEAD REF", ref: "@" + p, file: rel(root, f.path), line: i + 1 });
        }
      }
    });
  }
  return findings;
}

function checkDeadCmds(files, root) {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {}; } catch { return []; }
  const findings = [];
  const re = /`(?:npm run|pnpm|yarn) ([\w:.-]+)`/g;
  for (const f of files) {
    f.text.split("\n").forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        if (!(m[1] in scripts)) {
          findings.push({ kind: "DEAD CMD", cmd: m[1], file: rel(root, f.path), line: i + 1 });
        }
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
const KIND_COLOR = { CONFLICT: C.red, "DEAD REF": C.yellow, "DEAD CMD": C.yellow, DUPLICATE: C.magenta, MISSING: C.blue };

function grade(score) {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

function run(root, opts) {
  const files = (opts.user ? discoverUser() : discover(root))
    .map(f => ({ ...f, text: fs.readFileSync(f.path, "utf8") }));

  const findings = [
    ...checkConflicts(files, root),
    ...checkDeadRefs(files, root),
    ...checkDeadCmds(files, root),
    ...checkDuplicates(files, root),
  ];

  const hasAgents = files.some(f => path.basename(f.path) === "AGENTS.md");
  if (files.length && !hasAgents && !opts.user) {
    findings.push({ kind: "MISSING", file: "AGENTS.md", note: "30+ agents read AGENTS.md; only Claude reads CLAUDE.md" });
  }

  const perFile = files.map(f => ({ ...f, tokens: Math.round(f.text.length / 4) }));
  const totalTokens = perFile.reduce((s, f) => s + f.tokens, 0);

  let score = 100;
  const count = k => findings.filter(x => x.kind === k).length;
  score -= Math.min(50, count("CONFLICT") * 20);
  score -= Math.min(24, count("DEAD REF") * 6);
  score -= Math.min(20, count("DEAD CMD") * 8);
  score -= Math.min(15, count("DUPLICATE") * 5);
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
      console.log(`          ${f.file}:${f.line}  ${C.dim}no "${f.cmd}" script in package.json${C.reset}`);
    } else if (f.kind === "DUPLICATE") {
      console.log(`  ${c}DUPLICATE${C.reset} ~${f.len}-char block in ${f.files.length} files`);
      for (const p of f.files) console.log(`          ${C.dim}${p}${C.reset}`);
    } else if (f.kind === "MISSING") {
      console.log(`  ${c}MISSING${C.reset}   ${f.file}  ${C.dim}${f.note}${C.reset}`);
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
exist in package.json, blocks copy-pasted across files, missing AGENTS.md.`);
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
