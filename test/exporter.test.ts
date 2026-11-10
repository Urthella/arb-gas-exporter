// Runs the real exporter against fake JSON-RPC servers and reads /metrics as Prometheus would.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const one = JSON.parse(readFileSync(new URL("fixtures/arbitrum-one.json", import.meta.url), "utf8"));

/** A JSON-RPC server on a free port; `answer` gets each request and returns [status, body]. */
async function rpcServer(answer: (request: any) => [number, unknown]): Promise<string> {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const [status, reply] = answer(JSON.parse(body));
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startExporter(args: string[]) {
  const child = spawn(process.execPath, [MAIN, "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk) => (log += chunk));
  const { value: line } = await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next();
  const url = /serving (\S+)/.exec(String(line))?.[1];
  assert.ok(url, `no address in ${line}`);
  return { url, log: () => log, stop: () => child.kill() };
}

test("serves every chain's metrics and marks a broken RPC down", async () => {
  const good = await rpcServer((r) => [
    200,
    { jsonrpc: "2.0", id: r.id, result: r.method === "eth_blockNumber" ? one.block : one.replies[r.params[0].data] },
  ]);
  const broken = await rpcServer(() => [500, {}]);
  const limited = await rpcServer((r) => [200, { jsonrpc: "2.0", id: r.id, error: { code: -32005, message: "rate limited" } }]);
  const chains = ["--chain", `one=${good}`, "--chain", `broken=${broken}`, "--chain", `limited=${limited}`];
  const exporter = await startExporter(chains);
  try {
    const response = await fetch(exporter.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const text = await response.text();

    const sample = /^arbitrum_[a-z0-9_]+\{[a-z_]+="[^"\\]*"(?:,[a-z_]+="[^"\\]*")*\} -?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/;
    for (const line of text.trimEnd().split("\n")) {
      if (line.startsWith("# HELP ")) assert.match(line, /^# HELP arbitrum_[a-z0-9_]+ \S/);
      else if (line.startsWith("# TYPE ")) assert.match(line, /^# TYPE arbitrum_[a-z0-9_]+ gauge$/);
      else assert.match(line, sample);
    }
    const helps = text.match(/^# HELP \S+/gm) ?? [];
    assert.equal(new Set(helps).size, helps.length, "one HELP per metric");

    assert.match(text, /^arbitrum_up\{chain="one"\} 1$/m);
    assert.match(text, /^arbitrum_up\{chain="broken"\} 0$/m);
    assert.match(text, /^arbitrum_up\{chain="limited"\} 0$/m);
    assert.match(exporter.log(), /broken: eth_blockNumber: HTTP 500/);
    assert.match(exporter.log(), /limited: eth_blockNumber: rate limited/);
    assert.match(text, new RegExp(`^arbitrum_l2_base_fee_wei\\{chain="one"\\} ${BigInt(one.baseFeePerGas)}$`, "m"));
    assert.match(text, /^arbitrum_gas_constraint_backlog\{chain="one",constraint="0",window_seconds="9"\} \d+$/m);
    assert.doesNotMatch(text, /arbitrum_l2_base_fee_wei\{chain="broken"/);
    assert.match(text, /^arbitrum_scrape_duration_seconds\{chain="broken"\} \d/m);

    assert.equal((await fetch(new URL("/", exporter.url))).status, 404);
  } finally {
    exporter.stop();
  }
});

test("refuses a --chain without a name", () => {
  const run = spawnSync(process.execPath, [MAIN, "--chain", "http://localhost:8547"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /NAME=RPC_URL/);
});
