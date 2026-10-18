import type { publicEncounterPreview } from "../../game/encounter/preview.ts";
export function renderEncounter(canvas: HTMLCanvasElement, game: ReturnType<typeof publicEncounterPreview>) {
  const c = canvas.getContext("2d"); if (!c) throw new Error("2D canvas unavailable");
  c.clearRect(0, 0, canvas.width, canvas.height); c.fillStyle = "#0a1513"; c.fillRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = "rgba(130,180,165,.08)"; c.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 64) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, canvas.height); c.stroke(); }
  for (let y = 0; y < canvas.height; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(canvas.width, y); c.stroke(); }
  for (const t of game.telegraphs) {
    c.beginPath(); c.arc(t.x, t.y, t.radius, 0, Math.PI * 2); c.fillStyle = "rgba(255,166,64,.22)"; c.fill();
    c.strokeStyle = "#ffb454"; c.lineWidth = 4; c.stroke();
    c.fillStyle = "#ffe8cc"; c.font = "16px monospace"; c.textAlign = "center";
    c.fillText(`${Math.max(0, (t.resolveTick - game.tick) * .05).toFixed(1)}s`, t.x, t.y + 5);
  }
  for (const d of game.drops) { c.fillStyle = "#b0c9c0"; c.fillRect(d.x - 8, d.y - 8, 16, 16); }
  for (const enemy of game.enemies) {
    c.beginPath(); c.arc(enemy.x, enemy.y, 16, 0, Math.PI * 2); c.fillStyle = "#e85959"; c.fill();
    c.fillStyle = "#ff8787"; c.fillRect(enemy.x - 18, enemy.y - 27, 36 * enemy.hp / enemy.maxHp, 4);
  }
  c.beginPath(); c.arc(game.player.x, game.player.y, 14, 0, Math.PI * 2); c.fillStyle = "#63e6be"; c.fill();
}
