#!/usr/bin/env node
// Runs one bridge task through `codex exec` and records the log and final message next to the report.
// If Codex stops before writing the report, the same session is resumed; when the log shows the
// model is at capacity, the resume switches to the next --fallback model.
// Usage: node 文档/agent-bridge/run-task.mjs <task.md> [--sandbox MODE] [--timeout MINUTES] [--model NAME] [--retries N] [--fallback a,b] [--resume SESSION_ID]
import { execSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "Usage: node 文档/agent-bridge/run-task.mjs <task.md> [--sandbox MODE] [--timeout MINUTES] [--model NAME] [--retries N] [--fallback a,b] [--resume SESSION_ID]";
const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(bridgeDir, "../..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args.splice(index, 2)[1] : fallback;
};
const sandbox = option("--sandbox", "workspace-write");
const timeoutMinutes = Number(option("--timeout", "30"));
const retries = Number(option("--retries", "5"));
const fallbackModels = option("--fallback", process.env.CODEX_FALLBACK_MODELS ?? "gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-6-sol")
    .split(",").map((item) => item.trim()).filter(Boolean);
let currentModel = option("--model", "");
const resumeId = option("--resume", "");
const taskArg = args[0];

if (!taskArg || !existsSync(taskArg)) {
    console.error(USAGE);
    process.exit(2);
}

// Launch codex.js with node directly: going through the Windows .cmd shim needs a shell,
// which splits arguments on the space in this repository's path.
const codexEntry = process.env.CODEX_JS ?? path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@openai/codex/bin/codex.js");
if (!existsSync(codexEntry)) {
    console.error(`[bridge] Codex CLI not found at ${codexEntry}; install it with: npm i -g @openai/codex (or set CODEX_JS)`);
    process.exit(2);
}

const taskPath = path.resolve(taskArg);
const name = path.basename(taskPath, ".md");
const reportsDir = path.join(bridgeDir, "reports");
mkdirSync(reportsDir, { recursive: true });
const relativeTask = path.relative(repoRoot, taskPath).split(path.sep).join("/");
const relativeReport = `文档/agent-bridge/reports/${name}.md`;
const reportPath = path.join(repoRoot, relativeReport);
const logPath = path.join(reportsDir, `${name}.log`);
const lastPath = path.join(reportsDir, `${name}.last.txt`);

const firstPrompt = [
    `处理协作任务单 ${relativeTask}。`,
    "先阅读仓库根目录的 AGENTS.md 和该任务单，只做任务单要求的事，不要 git commit。",
    `完成后运行任务单中的验证命令，并用文件编辑工具把报告写到 ${relativeReport}（格式见 文档/agent-bridge/README.md），写完读回确认非空。`,
    "报告必须如实反映验证结果。",
].join("\n");
const resumePrompt = [
    "上一轮在写报告前中断了（可能是模型容量或网络错误）。",
    `检查 ${relativeTask} 的要求是否都已完成：未完成的继续做；已完成的不要重复修改。`,
    `然后用文件编辑工具把报告写到 ${relativeReport}，写完读回确认非空。验证结果以实际运行输出为准。`,
].join("\n");

// A resumed run appends to the existing log so the session id and history stay in one file.
const log = createWriteStream(logPath, { flags: resumeId ? "a" : "w" });
let logOffset = 0;

function runCodex(codexArgs, prompt) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [codexEntry, ...codexArgs], { cwd: repoRoot, windowsHide: true });
        child.stdin.end(prompt);
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        const timer = setTimeout(() => {
            log.write("\n[bridge] timed out\n");
            child.kill();
        }, timeoutMinutes * 60 * 1000);
        child.on("close", (code) => {
            clearTimeout(timer);
            // Let buffered log output reach the file before it is inspected.
            log.write("", () => resolve(code ?? 1));
        });
    });
}

function sessionId() {
    if (resumeId) return resumeId;
    const match = readFileSync(logPath, "utf8").match(/session id:\s*([0-9a-f-]{36})/i);
    return match?.[1];
}

/** Codex sometimes creates the report and fails before filling it; an empty file does not count. */
function reportReady() {
    return existsSync(reportPath) && statSync(reportPath).size > 0;
}

/** True when the log written since the previous check contains a capacity / rate-limit error. */
function hitCapacity() {
    const text = readFileSync(logPath, "utf8");
    const fresh = text.slice(logOffset);
    logOffset = text.length;
    return /at capacity|rate.?limit|overloaded/i.test(fresh);
}

const withModel = (list) => (currentModel ? [...list, "-m", currentModel] : list);

console.log(`[bridge] task=${relativeTask} sandbox=${sandbox} timeout=${timeoutMinutes}min retries=${retries}`);
console.log(`[bridge] log=${path.relative(repoRoot, logPath)}`);
let code = resumeId
    ? await runCodex([...withModel(["exec", "resume", "-c", `sandbox_mode="${sandbox}"`, "-o", lastPath]), resumeId, "-"], resumePrompt)
    : await runCodex([...withModel(["exec", "-C", repoRoot, "-s", sandbox, "--color", "never", "-o", lastPath]), "-"], firstPrompt);

for (let attempt = 1; attempt <= retries && !reportReady(); attempt += 1) {
    const id = sessionId();
    if (!id) break;
    if (hitCapacity() && fallbackModels.length > 0) currentModel = fallbackModels.shift();
    const delay = 45 * attempt;
    console.log(`[bridge] report missing (exit ${code}); resuming ${id} with model ${currentModel || "default"} in ${delay}s (${attempt}/${retries})`);
    log.write(`\n[bridge] resume attempt ${attempt} model=${currentModel || "default"}\n`);
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    code = await runCodex([...withModel(["exec", "resume", "-c", `sandbox_mode="${sandbox}"`, "-o", lastPath]), id, "-"], resumePrompt);
}

log.end();
const ready = reportReady();
console.log(`[bridge] codex exited with ${code}; report ${ready ? "written" : "MISSING"}: ${relativeReport}`);
process.exit(ready ? 0 : 1);
