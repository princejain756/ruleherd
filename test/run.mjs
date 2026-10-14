// self-check: build a fixture with planted drift, assert ruleherd finds it.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "ruleherd.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruleherd-"));

const sharedPara = `Before writing any code, run the full test suite and make sure it passes locally. Never push directly to main without a pull request. Keep functions small and readable.`;

fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node test.js", build: "node build.js" } }));
fs.writeFileSync(path.join(tmp, "realfile.md"), "# exists\n");
fs.writeFileSync(path.join(tmp, "CLAUDE.md"), `# rules
- indent with tabs everywhere
- use npm run build to compile
- see \`docs/ARCHITECTURE.md\` for the layout
- more at \`realfile.md\`

${sharedPara}
`);
fs.writeFileSync(path.join(tmp, "AGENTS.md"), `# rules
- indent with spaces, 2 per level
- use pnpm install and pnpm test
- run \`npm run deploy\` before pushing
- always push to main directly

${sharedPara}
`);

const out = execFileSync("node", [bin, tmp, "--json"], { encoding: "utf8" });
const r = JSON.parse(out);

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? " PASS " : " FAIL ") + msg); if (!cond) fails++; };

ok(r.files.length === 2, `found 2 files (got ${r.files.length})`);
ok(r.findings.some(f => f.kind === "CONFLICT" && f.topic === "indentation"), "tabs-vs-spaces conflict");
ok(r.findings.some(f => f.kind === "CONFLICT" && f.topic === "package manager"), "npm-vs-pnpm conflict");
ok(r.findings.some(f => f.kind === "CONFLICT" && /push/.test(f.topic)), "push-to-main polarity conflict");
ok(r.findings.some(f => f.kind === "DEAD REF" && f.ref === "docs/ARCHITECTURE.md"), "dead ref docs/ARCHITECTURE.md");
ok(!r.findings.some(f => f.kind === "DEAD REF" && f.ref === "realfile.md"), "realfile.md not flagged");
ok(r.findings.some(f => f.kind === "DEAD CMD" && f.cmd === "deploy"), "dead cmd npm run deploy");
ok(!r.findings.some(f => f.kind === "DEAD CMD" && f.cmd === "build"), "npm run build not flagged");
ok(r.findings.some(f => f.kind === "DUPLICATE"), "duplicated paragraph across CLAUDE.md + AGENTS.md");
ok(r.score < 100 && r.score >= 0, `score penalized (${r.score}/100, grade ${r.grade})`);

// clean repo -> grade A, no findings
const clean = fs.mkdtempSync(path.join(os.tmpdir(), "ruleherd-clean-"));
fs.writeFileSync(path.join(clean, "AGENTS.md"), "# rules\n- run `npm test` first\n- see `README.md`\n");
fs.writeFileSync(path.join(clean, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
fs.writeFileSync(path.join(clean, "README.md"), "hi\n");
const r2 = JSON.parse(execFileSync("node", [bin, clean, "--json"], { encoding: "utf8" }));
ok(r2.findings.length === 0, `clean repo has 0 findings (got ${r2.findings.length})`);
ok(r2.grade === "A", `clean repo grades A (got ${r2.grade})`);

// --strict exit code
let code = 0;
try { execFileSync("node", [bin, tmp, "--strict"], { encoding: "utf8" }); } catch (e) { code = e.status; }
ok(code === 1, "--strict exits 1 on findings");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(clean, { recursive: true, force: true });
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
