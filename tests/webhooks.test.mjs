import assert from "node:assert/strict";
import test from "node:test";
import { createWebhookVerifier, hmacSha256, verifyHmacSha256 } from "../server/webhooks/verify.mjs";

const secret = "webhook-test-secret";
const payload = '{"id":"evt_123","type":"payment.succeeded"}';
const signature = hmacSha256({ secret, payload });

test("verifies a valid HMAC-SHA256 signature", () => {
  assert.equal(verifyHmacSha256({ secret, payload, signature }), true);
});

test("rejects altered payloads, secrets, and signatures", () => {
  assert.equal(verifyHmacSha256({ secret, payload: `${payload} `, signature }), false);
  assert.equal(verifyHmacSha256({ secret: "different-secret", payload, signature }), false);
  const alteredSignature = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
  assert.equal(verifyHmacSha256({ secret, payload, signature: alteredSignature }), false);
});

test("rejects missing or malformed signature input without throwing", () => {
  for (const invalidSignature of [undefined, "", "sha256=abc", "not-hex", signature.slice(0, -2)]) {
    assert.doesNotThrow(() => assert.equal(verifyHmacSha256({ secret, payload, signature: invalidSignature }), false));
  }
  assert.equal(verifyHmacSha256({ secret: "", payload, signature }), false);
  assert.equal(verifyHmacSha256({ secret, payload: undefined, signature }), false);
});

test("delegates to an injected strategy and records accepted audit events", () => {
  const auditEvents = [];
  const verifier = createWebhookVerifier({
    strategy: ({ signature: received }) => received === "trusted",
    audit: (event) => auditEvents.push(event),
  });

  assert.equal(verifier({ eventId: "evt_accepted", signature: "trusted" }), true);
  assert.deepEqual(auditEvents, [{ eventId: "evt_accepted", outcome: "accepted" }]);
});

test("records rejected audit events with a null event id when absent", () => {
  const auditEvents = [];
  const verifier = createWebhookVerifier({ audit: (event) => auditEvents.push(event) });

  assert.equal(verifier({ secret, payload, signature: "invalid" }), false);
  assert.deepEqual(auditEvents, [{ eventId: null, outcome: "rejected" }]);
});
