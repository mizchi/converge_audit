const [ownerPublicKey, unit = "demo", startHead = crypto.randomUUID(), playerId = "local-player", generationText = "0"] = process.argv.slice(2);
const generation = Number(generationText);
if (!/^[0-9a-f]{64}$/.test(ownerPublicKey ?? "") || !/^[A-Za-z0-9._:-]{1,128}$/.test(unit) || !startHead || startHead.length > 128 || !playerId || playerId.length > 128 || !/^\d+$/.test(generationText) || !Number.isSafeInteger(generation) || generation < 0) {
  throw new Error("Usage: pnpm dev:assign-start <device-public-key> [unit] [startHead] [playerId] [generation=0]");
}
const localOrigin = new URL(process.env.ENCOUNTER_LOCAL_ORIGIN ?? "http://127.0.0.1:8787");
if (localOrigin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(localOrigin.hostname)) throw new Error("This development helper only sends to loopback HTTP");
const response = await fetch(new URL(`/v1/pve/${unit}/encounter-admissions`, localOrigin), {
  method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN ?? "test-admin-token"}` },
  body: JSON.stringify({ unit, startHead, playerId, ownerPublicKey, ...(generation > 0 ? { generation } : {}) }),
});
if (!response.ok) throw new Error(`Local start assignment refused: HTTP ${response.status}`);
await response.body?.cancel(); console.log(`Assigned start ${startHead} in ${unit}. Refresh the game screen.`);
export {};
