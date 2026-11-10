import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { keccak_256 } from "@noble/hashes/sha3.js";

import {
  ARB_GAS_INFO,
  ARB_SYS,
  NODE_INTERFACE,
  type Rpc,
  SELECTORS,
  type Sample,
  array,
  scrape,
  signed,
  words,
} from "../src/arbitrum.ts";

const TRANSFER = SELECTORS["gasEstimateL1Component(address,bool,bytes)"];

interface Fixture {
  block: string;
  baseFeePerGas: string;
  replies: Record<string, string>;
}

/** Replies captured from the real chain at one block (see the README). */
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));

/** A fake RPC that answers from a fixture by selector, lets a test replace some answers, and
 * records calls. */
function fake(f: Fixture, replace: Record<string, () => unknown> = {}) {
  const calls: { to: string; data: string; block: unknown }[] = [];
  const rpc: Rpc = async (method, params) => {
    if (method === "eth_blockNumber") return f.block;
    const { to, data } = params[0] as { to: string; data: string };
    calls.push({ to, data, block: params[1] });
    const selector = data.slice(0, 10);
    return replace[selector] ? replace[selector]() : f.replies[selector];
  };
  return { rpc, calls };
}

const find = (samples: Sample[], name: string, labels?: Record<string, string>) =>
  samples.find((s) => s.name === name && JSON.stringify(s.labels) === JSON.stringify(labels))?.value;
const word = (n: bigint) => (n < 0n ? n + (1n << 256n) : n).toString(16).padStart(64, "0");
const abi = (...ns: bigint[]) => "0x" + ns.map(word).join("");

test("each selector is the start of its signature's Keccak-256", () => {
  for (const [signature, selector] of Object.entries(SELECTORS)) {
    const hash = keccak_256(new TextEncoder().encode(signature)).subarray(0, 4);
    assert.equal(selector, "0x" + Buffer.from(hash).toString("hex"), signature);
  }
});

test("reads Arbitrum One as captured, and its base fee matches the block's", async () => {
  const one = fixture("arbitrum-one");
  const { rpc, calls } = fake(one);
  const samples = await scrape(rpc);

  assert.equal(find(samples, "block_number"), BigInt(one.block));
  assert.equal(find(samples, "l2_base_fee_wei"), BigInt(one.baseFeePerGas), "eth_getBlockByNumber agrees");
  assert.equal(find(samples, "arbos_version"), 61n, "arbOSVersion() is 55 + the version");
  const perByte = find(samples, "l1_calldata_byte_price_wei") as bigint;
  assert.equal(find(samples, "l1_cost_simple_tx_wei"), 140n * perByte, "Nitro's simple tx is 140 bytes");
  assert.ok((find(samples, "l1_pricing_surplus_wei") as bigint) > 0n);

  // Read by hand from the captured replies, word by word, without the code under test.
  const wordOf = (signature: keyof typeof SELECTORS, i: number) =>
    BigInt("0x" + one.replies[SELECTORS[signature]].slice(2 + 64 * i, 2 + 64 * (i + 1)));
  assert.equal(find(samples, "gas_speed_limit_per_second"), wordOf("getGasAccountingParams()", 0));
  assert.equal(find(samples, "gas_speed_limit_per_second"), 7_000_000n);
  assert.equal(find(samples, "l1_base_fee_estimate_wei"), wordOf("getL1BaseFeeEstimate()", 0));
  assert.equal(find(samples, "gas_backlog"), wordOf("getGasBacklog()", 0));
  // Nitro reports the floor as getPricesInWei's fourth field when the price is above it.
  assert.equal(find(samples, "l2_minimum_base_fee_wei"), wordOf("getPricesInWei()", 3));

  const l1Gas = wordOf("gasEstimateL1Component(address,bool,bytes)", 0);
  assert.equal(l1Gas, 133n, "as captured");
  assert.equal(find(samples, "eth_transfer_l1_gas_estimate"), l1Gas);
  const stateBaseFee = wordOf("gasEstimateL1Component(address,bool,bytes)", 1);
  assert.equal(find(samples, "eth_transfer_cost_estimate_wei"), (21_000n + l1Gas) * stateBaseFee);

  const windows = samples.filter((s) => s.name === "gas_constraint_backlog").map((s) => s.labels?.window_seconds);
  assert.deepEqual(windows, ["9", "52", "329", "2105", "13485", "86400"]);
  const resources = samples.filter((s) => s.name === "multigas_base_fee_wei").map((s) => s.labels?.resource);
  assert.deepEqual(resources.slice(0, 2), ["unknown", "computation"]);
  assert.equal(resources.length, 9);

  assert.equal(calls.length, Object.keys(SELECTORS).length);
  const where: Record<string, string> = { [SELECTORS["arbOSVersion()"]]: ARB_SYS, [TRANSFER]: NODE_INTERFACE };
  for (const { to, data, block } of calls) {
    assert.equal(block, one.block, "every call is pinned to one block");
    assert.equal(to, where[data.slice(0, 10)] ?? ARB_GAS_INFO);
  }
  // A plain transfer, ABI-encoded by hand: to 0x…dEaD, false, then empty bytes at offset 0x60.
  const transfer = calls.find((c) => c.data.startsWith(TRANSFER))?.data;
  const expected =
    TRANSFER + "0".repeat(60) + "dead" + "0".repeat(64) + "0".repeat(62) + "60" + "0".repeat(64);
  assert.equal(transfer, expected);
  for (const { data } of calls) if (data !== transfer) assert.equal(data.length, 10, "no arguments");
});

test("reads Nova's deficit as negative and its single-constraint pricing", async () => {
  const nova = fixture("arbitrum-nova");
  const samples = await scrape(fake(nova).rpc);
  const raw = BigInt(nova.replies[SELECTORS["getL1PricingSurplus()"]]);
  assert.ok(raw >= 1n << 255n, "the captured surplus is a negative int256");
  assert.equal(find(samples, "l1_pricing_surplus_wei"), raw - (1n << 256n));
  assert.equal(find(samples, "l2_base_fee_wei"), BigInt(nova.baseFeePerGas));
  assert.equal(samples.filter((s) => s.name.startsWith("gas_constraint_")).length, 0, "Nova has none");
  assert.ok(find(samples, "gas_backlog") !== undefined);
  // Nova's parent-chain data is priced far higher: about a million L1 gas for a transfer.
  assert.equal(find(samples, "eth_transfer_l1_gas_estimate"), 1_019_345n);
});

test("leaves out what an older ArbOS doesn't have, instead of failing", async () => {
  const one = fixture("arbitrum-one");
  const revert = () => Promise.reject(new Error("execution reverted"));
  const samples = await scrape(
    fake(one, {
      [SELECTORS["getGasPricingConstraints()"]]: revert,
      [SELECTORS["getMultiGasBaseFee()"]]: () => "0x",
      [SELECTORS["arbOSVersion()"]]: () => abi(1n, 2n),
      [TRANSFER]: revert,
    }).rpc,
  );
  assert.equal(find(samples, "l2_base_fee_wei"), BigInt(one.baseFeePerGas));
  const gone = ["gas_constraint_backlog", "multigas_base_fee_wei", "arbos_version", "eth_transfer_cost_estimate_wei"];
  for (const name of gone) {
    assert.ok(!samples.some((s) => s.name === name), name);
  }
  assert.ok(find(samples, "gas_backlog") !== undefined);
});

test("fails on a chain that isn't Arbitrum, or an RPC with no block", async () => {
  const one = fixture("arbitrum-one");
  await assert.rejects(scrape(fake(one, { [SELECTORS["getPricesInWei()"]]: () => "0x" }).rpc));
  const reverted = { [SELECTORS["getPricesInWei()"]]: () => Promise.reject(new Error("execution reverted")) };
  await assert.rejects(scrape(fake(one, reverted).rpc), /execution reverted/);
  await assert.rejects(scrape(async () => null), /no block number/);
  await assert.rejects(scrape(async () => "latest"), /no block number/);
});

test("decodes ABI words, int256 and dynamic arrays, and rejects malformed ones", () => {
  assert.deepEqual(words(abi(1n, 2n)), [1n, 2n]);
  assert.deepEqual(words("0x"), []);
  for (const bad of ["0x1", "0xzz" + "0".repeat(62), 7, undefined]) assert.throws(() => words(bad));

  assert.equal(signed((1n << 256n) - 1n), -1n);
  assert.equal(signed(1n << 255n), -(1n << 255n));
  assert.equal(signed((1n << 255n) - 1n), (1n << 255n) - 1n);

  assert.deepEqual(array(abi(32n, 2n, 5n, 6n, 7n, 8n, 9n, 10n), 3), [[5n, 6n, 7n], [8n, 9n, 10n]]);
  assert.deepEqual(array(abi(32n, 0n), 1), []);
  assert.deepEqual(array(abi(64n, 99n, 1n, 4n), 1), [[4n]], "the offset is honoured");
  const malformed = ["0x", abi(33n, 1n, 1n), abi(96n, 1n), abi(32n, 2n, 1n), abi(32n, 1n, 1n, 2n), abi(32n, 1n << 64n)];
  for (const bad of malformed) assert.throws(() => array(bad, 1), bad);
  assert.throws(() => array(abi(32n, 1n, 1n, 2n, 3n, 4n), 3));
});
