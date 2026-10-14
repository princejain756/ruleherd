// self-check: build a fixture with planted drift, assert ruleherd finds it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ruleherd.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruleherd-"));

const sharedPara = `Before writing any code, run the full test suite and make sure it passes locally. Never push directly to main without a pull request. Keep functions small and readable.`;

fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
  name: "fixture",
  scripts: { test: "node test.js", build: "node build.js" },
  dependencies: { react: "^19.0.0", next: "^14.2.0" },
}));
fs.writeFileSync(path.join(tmp, "realfile.md"), "# exists\n");
fs.writeFileSync(path.join(tmp, "CLAUDE.md"), `# rules
- indent with tabs everywhere
- use npm run build to compile
- see \`docs/ARCHITECTURE.md\` for the layout
- more at \`realfile.md\`
- types come from \`@types/node\`
- example layout: \`\`\`\nsrc/features/auth/login.ts\n\`\`\`
- in the next 2 steps, run lint
- after the fence, see \`config/missing.toml\`

${sharedPara}
`);
fs.writeFileSync(path.join(tmp, "AGENTS.md"), `# rules
- indent with spaces, 2 per level
- use pnpm install and pnpm test
- install deps with \`pnpm install\`
- run \`npm run deploy\` before pushing
- always push to main directly
- still on react 17, class components only
- types come from \`@types/react\`

${sharedPara}
`);
// BOM + CRLF line endings + a dead ref: neither may break parsing
fs.writeFileSync(path.join(tmp, "CLAUDE.local.md"), "\uFEFF# local\r\n- see `notes/ghost-todo.md`\r\n");
// a .mdc rule: frontmatter says "never push" (must NOT trigger a polarity
// conflict — frontmatter is metadata, not prose) and uses yaml list globs
fs.mkdirSync(path.join(tmp, ".cursor", "rules"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".cursor", "rules", "scoped.mdc"), `---
description: never push anything anywhere
globs:
  - gone-dir/**
  - ../**
---
scoped rule body
`);
// symlink alias: same content must not count as a second file or a duplicate.
// guarded: plain Windows users can't create symlinks (EPERM).
let symlinkOk = true;
try { fs.symlinkSync("CLAUDE.md", path.join(tmp, "GEMINI.md")); } catch { symlinkOk = false; }

const out = execFileSync("node", [bin, tmp, "--json"], { encoding: "utf8" });
const r = JSON.parse(out);

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? " PASS " : " FAIL ") + msg); if (!cond) fails++; };

ok(r.files.length === 4, `found 4 files (symlink deduped, got ${r.files.length})`);
ok(r.findings.some(f => f.kind === "CONFLICT" && f.topic === "indentation"), "tabs-vs-spaces conflict");
ok(r.findings.some(f => f.kind === "CONFLICT" && f.topic === "package manager"), "npm-vs-pnpm conflict");
ok(r.findings.filter(f => f.kind === "CONFLICT" && /push/.test(f.topic)).length === 1, "push-to-main polarity conflict (once, frontmatter not counted)");
ok(r.findings.some(f => f.kind === "DEAD REF" && f.ref === "docs/ARCHITECTURE.md"), "dead ref docs/ARCHITECTURE.md");
ok(!r.findings.some(f => f.kind === "DEAD REF" && /realfile/.test(f.ref)), "realfile.md not flagged");
ok(!r.findings.some(f => f.kind === "DEAD REF" && /types\/node|types\/react/.test(f.ref)), "@types/* not flagged as dead ref");
ok(!r.findings.some(f => f.kind === "DEAD REF" && /login\.ts/.test(f.ref)), "fenced example path not flagged");
// dead ref after a multi-line fence must report its true line number (11)
const toml = r.findings.find(f => f.kind === "DEAD REF" && f.ref === "config/missing.toml");
ok(toml && toml.line === 11, `dead ref after fence at true line (got ${toml?.line})`);
ok(r.findings.some(f => f.kind === "DEAD REF" && f.ref === "notes/ghost-todo.md"), "BOM+CRLF file dead ref still found");
ok(r.findings.some(f => f.kind === "DEAD CMD" && f.cmd === "deploy"), "dead cmd npm run deploy");
ok(!r.findings.some(f => f.kind === "DEAD CMD" && /^(build|install)$/.test(f.cmd)), "pnpm install / npm run build not flagged");
ok(r.findings.some(f => f.kind === "DUPLICATE"), "duplicated paragraph across CLAUDE.md + AGENTS.md");
if (symlinkOk) ok(!r.findings.some(f => f.kind === "DUPLICATE" && f.files.some(p => /GEMINI/.test(p))), "symlink alias not counted as duplicate");
ok(r.findings.some(f => f.kind === "STALE" && /react/i.test(f.ref)), "stale react 17 vs installed 19");
ok(!r.findings.some(f => f.kind === "STALE" && /next/i.test(f.ref)), "'the next 2 steps' not a stale Next.js version");
ok(r.findings.some(f => f.kind === "DEAD GLOB" && /gone-dir/.test(f.ref)), "yaml list glob to missing dir flagged");
ok(!r.findings.some(f => f.kind === "DEAD GLOB" && /^\.\./.test(f.ref)), "../ glob prefix resolves, not flagged");
ok(r.score < 100 && r.score >= 0, `score penalized (${r.score}/100, grade ${r.grade})`);

// clean repo -> grade A, no findings; one file that alone mentions both npm
// and pnpm must not produce a same-file "conflict"
const clean = fs.mkdtempSync(path.join(os.tmpdir(), "ruleherd-clean-"));
fs.writeFileSync(path.join(clean, "AGENTS.md"), "# rules\r\n- run `npm test` first\r\n- if npm misbehaves, `pnpm install` works too\r\n- see `README.md`\r\n");
fs.writeFileSync(path.join(clean, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
fs.writeFileSync(path.join(clean, "README.md"), "hi\n");
const r2 = JSON.parse(execFileSync("node", [bin, clean, "--json"], { encoding: "utf8" }));
ok(r2.findings.length === 0, `clean repo has 0 findings (got ${r2.findings.length}${r2.findings.length ? ": " + JSON.stringify(r2.findings[0]) : ""})`);
ok(r2.grade === "A", `clean repo grades A (got ${r2.grade})`);

// --strict exit code
let code = 0;
try { execFileSync("node", [bin, tmp, "--strict"], { encoding: "utf8" }); } catch (e) { code = e.status; }
ok(code === 1, "--strict exits 1 on findings");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(clean, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
