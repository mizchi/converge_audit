import { sha256Hasher } from "../src/core/hash.ts";
import { gameCommandOrder, gameProtocol, type GameCommand } from "../src/examples/mmo/index.ts";
import { sharedSecretAuthenticator } from "../src/finalizer/finalizer.ts";
import { createSingleAuthority, createSingleAuthorityFinalizer } from "../src/finalizer/single-authority.ts";
import { runSimulation } from "../src/runtime/simulator.ts";
import { worldWith } from "../src/examples/mmo/model.ts";

const seed = Number(process.argv[2] ?? 1);
const steps = Number(process.argv[3] ?? 500);
const authenticator = sharedSecretAuthenticator("simulate");
const protocol = gameProtocol({
  finalizer: createSingleAuthorityFinalizer<GameCommand>(authenticator),
  initialWorld: worldWith({
    "player-a": { hp: 30, maxHp: 30, mp: 100 },
    "player-b": { hp: 30, maxHp: 30, mp: 100 },
  }),
});
const authority = createSingleAuthority<GameCommand>({ signer: authenticator, order: gameCommandOrder, hasher: sha256Hasher });
const players = ["player-a", "player-b"];

const report = runSimulation({
  protocol,
  authority,
  seed,
  steps,
  generateCommand: (rng): GameCommand =>
    rng.chance(0.5)
      ? { type: "Damage", source: rng.pick(players), target: rng.pick(players), amount: 1 + rng.int(12) }
      : { type: "UseSkill", actor: rng.pick(players), skill: rng.pick(["fireball", "heal", "dash"]), mpCost: rng.int(40) },
});

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.converged ? 0 : 1;
