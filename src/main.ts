// arb-gas-exporter: serves Arbitrum gas prices as Prometheus metrics, reading every configured
// chain afresh on each scrape.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";

import { type Rpc, type Sample, scrape } from "./arbitrum.ts";
import { render } from "./prometheus.ts";

const RPC_TIMEOUT_MS = 10_000;
const USAGE = `usage: arb-gas-exporter [--chain NAME=RPC_URL]... [--address 127.0.0.1] [--port 9850]
  default chain: arbitrum-one=https://arb1.arbitrum.io/rpc`;

function jsonRpc(url: string): Rpc {
  let id = 0;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const reply = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (reply.error) throw new Error(`${method}: ${reply.error.message ?? "error"}`);
    return reply.result;
  };
}

async function read(chain: string, rpc: Rpc): Promise<{ chain: string; samples: Sample[] }> {
  const start = performance.now();
  let samples: Sample[];
  try {
    samples = [...(await scrape(rpc)), { name: "up", value: 1n }];
  } catch (error) {
    console.error(`arb-gas-exporter: ${chain}: ${(error as Error).message}`);
    samples = [{ name: "up", value: 0n }];
  }
  const seconds = Math.round(performance.now() - start) / 1000;
  return { chain, samples: [...samples, { name: "scrape_duration_seconds", value: seconds }] };
}

function parse(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      chain: { type: "string", multiple: true, default: ["arbitrum-one=https://arb1.arbitrum.io/rpc"] },
      address: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "9850" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) throw new Error(USAGE);
  const chains = values.chain.map((spec) => {
    const at = spec.indexOf("=");
    if (at < 1) throw new Error(`--chain takes NAME=RPC_URL, not ${spec}\n${USAGE}`);
    return { name: spec.slice(0, at), rpc: jsonRpc(spec.slice(at + 1)) };
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port takes 0 to 65535");
  return { chains, address: values.address, port };
}

function serve({ chains, address, port }: ReturnType<typeof parse>) {
  const server = createServer(async (request, response) => {
    if (request.url !== "/metrics") {
      response.writeHead(404, { "content-type": "text/plain" }).end("see /metrics\n");
      return;
    }
    const results = await Promise.all(chains.map(({ name, rpc }) => read(name, rpc)));
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    response.end(render(results));
  });
  server.listen(port, address, () => {
    const where = server.address() as AddressInfo;
    console.log(`arb-gas-exporter: serving http://${address}:${where.port}/metrics`);
  });
}

try {
  serve(parse(process.argv.slice(2)));
} catch (error) {
  // Not process.exit(): on Windows, Node can trip a libuv assertion exiting that early.
  console.error((error as Error).message);
  process.exitCode = 2;
}
