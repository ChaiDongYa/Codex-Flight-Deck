import { createHmac, timingSafeEqual } from "node:crypto";

const digestPattern = /^[a-f0-9]{64}$/i;

export function hmacSha256({ secret, payload }) {
  if (typeof secret !== "string" || secret.length === 0 || !(typeof payload === "string" || Buffer.isBuffer(payload) || payload instanceof Uint8Array)) return null;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyHmacSha256({ secret, payload, signature }) {
  if (typeof signature !== "string" || !digestPattern.test(signature)) return false;
  const expected = hmacSha256({ secret, payload });
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

export function createWebhookVerifier({ strategy = verifyHmacSha256, audit = () => {} } = {}) {
  return ({ secret, payload, signature, eventId } = {}) => {
    const valid = Boolean(strategy({ secret, payload, signature }));
    audit({ eventId: eventId ?? null, outcome: valid ? "accepted" : "rejected" });
    return valid;
  };
}
