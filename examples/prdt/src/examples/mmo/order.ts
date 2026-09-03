import { canonicalOrder, type CommandOrder } from "../../core/order.ts";
import { phaseOf, type GameCommand } from "./commands.ts";

/** (tick, phase, submittedBy, localSequence, commandId) */
export const gameCommandOrder: CommandOrder<GameCommand> = canonicalOrder(phaseOf);
