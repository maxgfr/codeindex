// Build the images first, then run: node scripts/test-docker.mjs [engine-tag] [embed-tag]
// Native local runtime checks; does not publish, and removes only its own containers.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const engine = process.argv[2] || "codeindex:qa-20260907";
const embed = process.argv[3] || "codeindex-embed:qa-20260907";
const engineOnly = process.argv.includes("--engine-only");
const scratch = mkdtempSync(join(tmpdir(), "codeindex-docker-smoke-"));
const repo = join(scratch, "repo"); mkdirSync(repo);
const container = `codeindex-embed-qa-${process.pid}`;
function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts });
  assert.equal(result.status, 0, `${bin} ${args.join(" ")}\n${result.error || ""}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const docker = (args, opts) => run("docker", args, opts);
const cli = (...args) => docker(["run", "--rm", "--network", "none", "-v", `${repo}:/work`, engine, ...args, "--repo", "/work"]);
const host = (...args) => run(process.execPath, [resolve(root, "scripts/cli.mjs"), ...args, "--repo", repo]);
let started = false;
try {
  console.log("Engine image:", docker(["image", "inspect", engine, "--format", "{{.Os}}/{{.Architecture}} {{.Id}} user={{.Config.User}} size={{.Size}}"]));
  assert.notEqual(docker(["run", "--rm", "--network", "none", "--entrypoint", "node", engine, "-p", "process.getuid()"] ).trim(), "0");
  writeFileSync(join(repo, "service.ts"), 'export function greet(name: string): string {\n  return `Hello ${name}`;\n}\n');
  writeFileSync(join(repo, "client.ts"), 'import { greet } from "./service";\nexport function start() {\n  return greet("world");\n}\n');
  assert.equal(JSON.parse(cli("scan")).fileCount, 2);
  assert.deepEqual(JSON.parse(cli("scan")), JSON.parse(host("scan")));
  const graph = cli("graph"); assert.equal(graph, host("graph"), "host/container non-git graph bytes");
  const defs = JSON.parse(cli("symbols")).defs.greet;
  assert.equal(defs[0].endLine, 3, "AST declaration line span");
  assert.equal(JSON.parse(cli("callers", "greet")).callers[0].file, "client.ts");
  assert.match(cli("search", "greet"), /service\.ts/);
  cli("index", "--out", "/work/.codeindex");
  assert.equal(readFileSync(join(repo, ".codeindex/graph.json"), "utf8"), graph);
  assert.equal(cli("graph"), graph, "warm artifact read");
  const requests = [
    { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "docker-test", version: "1" } } },
    { id: 2, method: "tools/call", params: { name: "callers", arguments: { name: "greet" } } },
  ].map((r) => JSON.stringify({ jsonrpc: "2.0", ...r })).join("\n") + "\n";
  const messages = docker(["run", "--rm", "-i", "--network", "none", "-v", `${repo}:/work`, engine, "mcp", "--repo", "/work"], { input: requests }).trim().split("\n").map(JSON.parse);
  const response = messages.find((m) => m.id === 2);
  assert.equal(response.result.isError, undefined); assert.match(response.result.content[0].text, /client\.ts/);
  for (const args of [["init"], ["add", "service.ts", "client.ts"], ["-c", "user.name=Docker QA", "-c", "user.email=docker-qa@example.invalid", "commit", "-m", "fixture"]]) run("git", ["-C", repo, ...args]);
  assert.deepEqual(JSON.parse(cli("churn")), JSON.parse(host("churn")), "Git churn works in the image");
  assert.equal(cli("graph"), host("graph"), "Git commit metadata matches host");
  assert.deepEqual(JSON.parse(cli("coupling")), JSON.parse(host("coupling")));
  writeFileSync(join(repo, "service.ts"), 'export function greet(name: string): string {\n  return `Welcome ${name}`;\n}\n');
  assert.deepEqual(JSON.parse(cli("delta", "--base", "HEAD", "--json")), JSON.parse(host("delta", "--base", "HEAD", "--json")));
  console.log("PASS engine: nonroot, offline AST, scan/index/warm/search/callers, MCP, host graph bytes, Git churn/coupling/delta");
  if (!engineOnly) {
    console.log("Embedding image:", docker(["image", "inspect", embed, "--format", "{{.Os}}/{{.Architecture}} {{.Id}} user={{.Config.User}} size={{.Size}}"]));
    docker(["run", "-d", "--name", container, "--network", "none", embed]); started = true;
    const checks = `
      const assert = require('node:assert/strict');
      (async()=>{
        assert.notEqual(process.getuid(),0);
        const base='http://127.0.0.1:8756';
        let ready=false;
        for(let i=0;i<60;i++){try { const r=await fetch(base+'/healthz'); if(r.ok){ready=true;break;} }catch{} await new Promise(r=>setTimeout(r,500));}
        assert.ok(ready,'offline model readiness');
        const post=async body=>{const r=await fetch(base+'/embed',{method:'POST',body:typeof body==='string'?body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
        const input={texts:['authentication checks the user identity','a cat naps in the sun']};
        const a=await post(input),b=await post(input);assert.equal(a.status,200);assert.deepEqual(a,b);
        assert.equal(a.body.vectors.length,2);for(const v of a.body.vectors){assert.equal(v.length,384);assert.ok(v.every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...v)-1)<0.0001);}
        assert.notDeepEqual(a.body.vectors[0],a.body.vectors[1]);
        assert.deepEqual((await post({texts:[]})).body,{vectors:[]});
        for(const body of ['{',null,{}, {texts:[1]}, {texts:['x'.repeat(8193)]}, {texts:Array(257).fill('x')}])assert.equal((await post(body)).status,400);
        assert.equal((await post('x'.repeat(2*1024*1024+1))).status,413);
        assert.equal((await fetch(base+'/missing')).status,404);
        assert.equal((await fetch(base+'/healthz')).status,200);
        console.log('PASS embed: offline/nonroot readiness, 384 finite normalized deterministic floats, empty/malformed/limits/413, post-error health');
      })().catch(e=>{console.error(e);process.exitCode=1;});`;
    console.log(docker(["exec", container, "node", "-e", checks]));
    const semantic = docker(["run", "--rm", "--network", `container:${container}`, "-e", "CODEINDEX_EMBED_ENDPOINT=http://127.0.0.1:8756", "-v", `${repo}:/work`, engine, "search", "greet", "--semantic", "--repo", "/work"]);
    assert.match(semantic, /service\.ts/);
    assert.ok(JSON.parse(semantic).some((hit) => hit.semanticSymbol), "query used real semantic vectors instead of lexical degradation");
    const status = JSON.parse(docker(["run", "--rm", "--network", `container:${container}`, "-e", "CODEINDEX_EMBED_ENDPOINT=http://127.0.0.1:8756", "-v", `${repo}:/work`, engine, "embed", "status", "--repo", "/work"]));
    assert.equal(status.mode, "endpoint");
    assert.equal(status.endpointReachable, true);
    console.log("PASS engine semantic endpoint integration", JSON.stringify(status));
  }
} finally {
  if (started) { const logs = spawnSync("docker", ["logs", container], { encoding: "utf8" }); console.log(logs.stdout, logs.stderr); spawnSync("docker", ["rm", "-f", container], { encoding: "utf8", timeout: 30_000 }); }
  rmSync(scratch, { recursive: true, force: true });
}
