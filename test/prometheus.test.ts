import assert from "node:assert/strict";
import { test } from "node:test";

import { render } from "../src/prometheus.ts";

test("groups samples by metric across chains, with one HELP and TYPE each", () => {
  const text = render([
    { chain: "a", samples: [{ name: "up", value: 1n }, { name: "l2_base_fee_wei", value: 7n }] },
    { chain: "b", samples: [{ name: "up", value: 0n }] },
  ]);
  assert.equal(
    text,
    [
      "# HELP arbitrum_up 1 if the last scrape of the chain's RPC worked, 0 if it didn't.",
      "# TYPE arbitrum_up gauge",
      'arbitrum_up{chain="a"} 1',
      'arbitrum_up{chain="b"} 0',
      "# HELP arbitrum_l2_base_fee_wei The L2 base fee per gas.",
      "# TYPE arbitrum_l2_base_fee_wei gauge",
      'arbitrum_l2_base_fee_wei{chain="a"} 7',
      "",
    ].join("\n"),
  );
});

test("escapes label values and keeps extra labels after the chain", () => {
  const text = render([
    { chain: 'my "test"\\net\nwork', samples: [{ name: "gas_constraint_backlog", labels: { constraint: "0" }, value: 5n }] },
  ]);
  const line = text.split("\n").find((l) => l.startsWith("arbitrum_gas_constraint_backlog{"));
  assert.equal(line, String.raw`arbitrum_gas_constraint_backlog{chain="my \"test\"\\net\nwork",constraint="0"} 5`);
});
