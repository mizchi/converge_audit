import { createStandardWebCryptoBackend } from "../../../player-local-runtime/crypto-backend.ts";
import { createInitialGame } from "../../game/kernel.ts";
import { ENCOUNTER_RULES, type EncounterAuthorization, type EncounterConfiguration } from "../../game/encounter/contracts.ts";
import { isDigest, isTime } from "../../game/encounter/wire.ts";
import { publicEncounterPreview } from "../../game/encounter/preview.ts";
import { renderEncounter } from "./encounter-renderer.ts";
import { IndexedDbEncounterSessionStore } from "./audit/encounter-session-store.ts";
import { EncounterSessionController } from "./audit/encounter-session.ts";
import { HttpEncounterTransport } from "./audit/encounter-http.ts";
import { IndexedDbAuditPayloadPool } from "./audit/payload-pool.ts";
import { ENCOUNTER_POOL_LIMITS, ENCOUNTER_POOL_MAX_QUEUES, ENCOUNTER_POOL_NAME } from "./audit/encounter-recorder.ts";

const el = <T extends HTMLElement>(id: string) => {
  const value = document.getElementById(id); if (!value) throw new Error(`missing element ${id}`); return value as T;
};
const canvas = el<HTMLCanvasElement>("arena");
const startButton = el<HTMLButtonElement>("start"); const refreshButton = el<HTMLButtonElement>("refresh");
const terminateButton = el<HTMLButtonElement>("terminate"); const cleanupButton = el<HTMLButtonElement>("cleanup");
const forgetButton = el<HTMLButtonElement>("forget-terminated");
const archiveButton = el<HTMLButtonElement>("archive");
const compactButton = el<HTMLButtonElement>("compact");
const retireEmptyButton = el<HTMLButtonElement>("retire-empty");
const inventoryFirst = el<HTMLButtonElement>("inventory-first"); const inventoryNext = el<HTMLButtonElement>("inventory-next");
const selector = el<HTMLSelectElement>("admission");
const keys = new Set<string>();
const movement = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyA", "KeyD", "KeyW", "KeyS"];
const unit = new URL(location.href).searchParams.get("unit") ?? "demo";
const idle = publicEncounterPreview(createInitialGame({ seed: 0, playerId: "preview" }));
let session: EncounterSessionController | undefined;
let transport: HttpEncounterTransport | undefined;
let pool: IndexedDbAuditPayloadPool | undefined;
let store: IndexedDbEncounterSessionStore | undefined;
let starts: EncounterAuthorization[] = [];
let clockOffset = 0;
let archiveAvailable = false;
let releaseLock: (() => void) | undefined;
let requestId = 0; let stopped = false; let lastFrame = performance.now();
const now = () => Math.max(0, Math.floor(Date.now() + clockOffset));
function report(error: unknown) {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  const target = el("session-error"); target.hidden = false;
  target.textContent = /capacity/.test(message) ? "保存枠が上限に達しました。保持中のデータは削除していません。" :
    /another owner or unit/.test(message) ? "別の部屋の戦闘が保存されています。元の部屋で終了してください。" :
    /429/.test(message) ? "要求が多いため、少し待ってから状態を再確認してください。" :
    "処理を完了できませんでした。状態を再確認してください。";
}
const labels = { idle: "開始待ち", playing: "戦闘中", ready: "入力を固定しています", waiting: "戦利品の公開待ち",
  settled: "戦利品確定", terminated: "終了済み", interrupted: "中断を検出", error: "確認が必要です" };
function update() {
  if (!session) return;
  const c = session.current; const busy = session.busy;
  el("session-status").textContent = labels[session.phase];
  el("tick").textContent = `${session.tick} / 60`;
  el("durable").textContent = `${session.durableChunks} / 2`;
  const game = session.game; el("hp").textContent = game ? `${game.player.hp} / ${game.player.maxHp}` : "—";
  startButton.disabled = busy || starts.length === 0 || Boolean(c && !c.cleaned);
  selector.disabled = startButton.disabled; refreshButton.disabled = busy || session.phase === "playing";
  terminateButton.disabled = busy || !c?.ticket || Boolean(c.receipt || c.termination);
  forgetButton.disabled = busy || !c?.termination || !c.cleaned;
  archiveButton.disabled = busy || !archiveAvailable || !c?.receipt || c.cleaned;
  compactButton.disabled = busy || !session.canCompact || session.history.length + (c?.receipt ? 1 : 0) === 0;
  retireEmptyButton.disabled = busy || !session.canCompact || !session.inventoryPage.some((r) => r.receipt.statement.items.length === 0);
  inventoryFirst.disabled = busy || !session.checkpoint; inventoryNext.disabled = busy || !session.inventoryHasMore;
  const retentionUntil = c?.receipt?.statement.retentionUntil ?? c?.termination?.statement.retentionUntil;
  cleanupButton.disabled = busy || !c || c.cleaned || retentionUntil === undefined || now() < retentionUntil;
  cleanupButton.textContent = c?.cleaned ? "復旧用ログは解放済み" : retentionUntil !== undefined && now() < retentionUntil ?
    `ログ解放まで${Math.ceil((retentionUntil - now()) / 1000)}秒` : "復旧用ログを解放";
  el("session-message").textContent = session.phase === "interrupted" ? "保存済みの入力だけでは続行できません。中断して終了し、保持期限後にログを解放できます。" :
    session.phase === "terminated" ? "この戦闘から報酬は確定しません。開始権は消費済みのままです。" :
    session.phase === "settled" ? "署名付きレシートを保存しました。市場への持ち込みや、保持期限後のログ解放ができます。" :
    starts.length === 0 && !c ? "開始権がありません。運営によるこの端末への割り当てを待ってください。" :
    "画面を開いたままプレイしてください。戦利品の内容は確定後に表示します。";
  if (!session.error) el("session-error").hidden = true;
  const records = [...session.inventoryPage, ...session.history, ...(c?.ticket && c.receipt ? [{ ticket: c.ticket, receipt: c.receipt, admittedAssets: c.admittedAssets }] : [])];
  const inventory = el("inventory");
  inventory.replaceChildren(); let count = 0;
  for (const record of records) for (const item of record.receipt.statement.items) {
    count++; const card = document.createElement("article"); card.className = "item-card";
    const name = document.createElement("div"); name.className = `item-name rarity-${item.rarity}`; name.textContent = `${item.itemType} +${item.power}`;
    const meta = document.createElement("p"); meta.className = "item-meta"; meta.textContent = `${item.rarity} · 確定済み`;
    const button = document.createElement("button"); button.type = "button";
    const admitted = record.admittedAssets.includes(item.assetId); button.disabled = busy || admitted;
    button.textContent = admitted ? "市場で受理済み" : "市場へ持ち込む";
    button.onclick = () => void action(async () => { await session!.admit(item.assetId, record.ticket.ticketId); });
    card.append(name, meta, button); inventory.append(card);
  }
  const total = (session.checkpoint?.statement.itemCount ?? 0) + session.history.reduce((n, r) => n + r.receipt.statement.items.length, 0) + (c?.receipt?.statement.items.length ?? 0);
  el("inventory-count").textContent = session.checkpoint ? `${count}件表示 / ${total}件` : String(count);
  if (!count) inventory.textContent = session.checkpoint ? "このページに戦利品はありません。" : "戦利品の内容は確定後に表示されます。";
}
async function storageStatus() {
  if (!pool || !session) return;
  const p = await pool.snapshot();
  el("storage-status").textContent = `ログ ${p.usedBytes.toLocaleString()} bytes / 予約 ${p.reservedPayloadBytes.toLocaleString()} bytes · 端末レシート ${session.history.length + (session.receipt ? 1 : 0)} / 16戦 · 集約済み ${session.checkpoint?.statement.receiptCount ?? 0}戦`;
}
async function refreshStarts() {
  if (!transport) return;
  starts = await transport.admissions();
  if (!Array.isArray(starts) || starts.length > 32 || starts.some((a) => a.unit !== unit || a.ownerPublicKey !== el<HTMLInputElement>("owner-key").value)) throw new Error("invalid admissions");
  const previous = selector.value;
  selector.replaceChildren(...starts.map((authorization) => {
    const option = document.createElement("option"); option.value = authorization.startHead; option.textContent = `${authorization.playerId} · ${authorization.startHead}`; return option;
  }));
  if (starts.some((a) => a.startHead === previous)) selector.value = previous;
  update();
}
async function action(body: () => Promise<void>) {
  try { el("session-error").hidden = true; await body(); await storageStatus(); update(); }
  catch (error) { update(); report(error); }
}
function axis(negative: string[], positive: string[]): -1 | 0 | 1 {
  const n = negative.some((code) => keys.has(code)); const p = positive.some((code) => keys.has(code)); return n === p ? 0 : n ? -1 : 1;
}
startButton.onclick = () => void action(async () => {
  const authorization = starts.find((a) => a.startHead === selector.value); if (!authorization || !session) return;
  await session.start(authorization); lastFrame = performance.now(); await refreshStarts();
});
refreshButton.onclick = () => {
  if (!session) { location.reload(); return; }
  void action(async () => { await session!.refresh(); await refreshStarts(); });
};
terminateButton.onclick = () => void action(async () => { await session!.terminate(); });
cleanupButton.onclick = () => void action(async () => { await session!.cleanup(); await refreshStarts(); });
forgetButton.onclick = () => void action(async () => { await session!.forgetTerminated(); await refreshStarts(); });
archiveButton.onclick = () => void action(async () => { await session!.archive(); await refreshStarts(); });
compactButton.onclick = () => void action(async () => { await session!.compact(); });
retireEmptyButton.onclick = () => void action(async () => { await session!.retireEmptyInventory(); });
inventoryFirst.onclick = () => void action(async () => { await session!.loadInventory(); });
inventoryNext.onclick = () => void action(async () => { await session!.loadInventory(true); });
window.addEventListener("keydown", (event) => {
  if (movement.includes(event.code) && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLSelectElement)) { event.preventDefault(); keys.add(event.code); }
});
window.addEventListener("keyup", (event) => keys.delete(event.code)); window.addEventListener("blur", () => keys.clear());
document.addEventListener("visibilitychange", () => { keys.clear(); if (document.hidden) session?.interrupt(); lastFrame = performance.now(); });
function frame(time: number) {
  if (stopped) return;
  if (session) {
    if (time - lastFrame > 500) session.interrupt();
    if (session.phase === "playing" && !session.busy && time - lastFrame >= 50) {
      lastFrame += 50;
      void action(async () => { await session!.step(axis(["ArrowLeft", "KeyA"], ["ArrowRight", "KeyD"]), axis(["ArrowUp", "KeyW"], ["ArrowDown", "KeyS"])); });
    } else if (session.phase !== "playing") lastFrame = time;
    if (!session.busy && session.ticket && ((session.phase === "ready" && now() >= session.ticket.commitNotBefore) ||
      (session.phase === "waiting" && now() >= session.ticket.releaseAt))) void action(() => session!.advanceSettlement());
    renderEncounter(canvas, session.game ? publicEncounterPreview(session.game) : idle);
    const c = session.current; const deadline = c?.receipt?.statement.retentionUntil ?? c?.termination?.statement.retentionUntil;
    if (deadline !== undefined && !c?.cleaned && !session.busy) {
      cleanupButton.disabled = now() < deadline;
      cleanupButton.textContent = now() < deadline ? `ログ解放まで${Math.ceil((deadline - now()) / 1000)}秒` : "復旧用ログを解放";
    }
  }
  requestId = requestAnimationFrame(frame);
}
async function configuration(): Promise<EncounterConfiguration> {
  const response = await fetch(`/v1/pve/${unit}/encounter-configuration`, { cache: "no-store", redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`configuration HTTP ${response.status}`);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const n = await reader.read(); if (n.done) break; length += n.value.byteLength;
    if (length > 16_384) { await reader.cancel(); throw new Error("configuration too large"); } chunks.push(n.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as EncounterConfiguration;
  if (value.version !== 1 || value.unit !== unit || value.rulesId !== ENCOUNTER_RULES || !isDigest(value.authorityKey) || !isTime(value.serverNow) ||
      (value.archiveKey !== undefined && !isDigest(value.archiveKey)) || (value.generation !== undefined && !isTime(value.generation))) throw new Error("invalid encounter configuration");
  return value;
}
async function boot() {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(unit) || !navigator.locks) throw new Error("encounter environment unavailable");
  await navigator.locks.request("converge-audit-encounter-ui", { ifAvailable: true }, async (lock) => {
    if (!lock) { el("session-status").textContent = "別タブで進行中"; el("session-message").textContent = "操作中のタブを閉じてから、このページを再読み込みしてください。"; return; }
    try {
      const backend = createStandardWebCryptoBackend(crypto);
      store = await IndexedDbEncounterSessionStore.open({ factory: indexedDB });
      const owner = await store.owner(backend); el<HTMLInputElement>("owner-key").value = owner.publicKey; el("room-label").textContent = `部屋: ${unit}`;
      const config = await configuration(); clockOffset = config.serverNow - Date.now();
      archiveAvailable = config.archiveKey !== undefined;
      transport = new HttpEncounterTransport({ endpoint: `${location.origin}/v1/pve/${unit}/encounter`, unit, owner, cryptoBackend: backend, now });
      pool = await IndexedDbAuditPayloadPool.open({ factory: indexedDB, name: ENCOUNTER_POOL_NAME, limits: ENCOUNTER_POOL_LIMITS, maxQueues: ENCOUNTER_POOL_MAX_QUEUES });
      session = new EncounterSessionController({ factory: indexedDB, store, pool, owner, backend, transport, trustedKey: config.authorityKey,
        trustedArchiveKey: config.archiveKey, unit, now, changed: update });
      await session.initialize(); await refreshStarts(); await storageStatus(); update(); lastFrame = performance.now(); requestId = requestAnimationFrame(frame);
      await new Promise<void>((resolve) => { releaseLock = resolve; });
    } catch (error) {
      session?.close(); session = undefined;
      startButton.disabled = true; selector.disabled = true; terminateButton.disabled = true; cleanupButton.disabled = true; refreshButton.disabled = false;
      archiveButton.disabled = true;
      compactButton.disabled = true; retireEmptyButton.disabled = true; inventoryFirst.disabled = true; inventoryNext.disabled = true;
      el("session-status").textContent = "接続・保存状態の確認が必要です"; report(error);
    }
    finally { session?.close(); pool?.close(); store?.close(); }
  });
}
window.addEventListener("pagehide", () => { stopped = true; cancelAnimationFrame(requestId); releaseLock?.(); });
renderEncounter(canvas, idle);
void boot().catch(report);
