export interface InventoryLineageSemanticTransition {
  asset_id: string;
  origin_receipt_digest: string;
  from_owner: string;
  to_owner: string;
  expected_version: number;
  previous_event: string;
  source_event: string;
  previous_lineage_root: string;
  next_lineage_root: string;
}

export interface InventoryLineageSemanticTranscript {
  asset_id: string;
  current_owner_id: string;
  initial_owner_id: string;
  initial_version: number;
  initial_last_event: string;
  initial_lineage_root: string;
  transfer_count: number;
  transitions: InventoryLineageSemanticTransition[];
  final_owner_id: string;
  final_version: number;
  final_last_event: string;
  final_lineage_root: string;
}

export interface AsyncInventoryLineageSemanticDigest {
  hashString(value: string): Promise<string>;
}

export type VerifyInventoryLineageSemanticsResult =
  | { ok: true; transitionCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "transition_mismatch"
        | "root_mismatch";
      transitionIndex: number;
    };

function appendField(value: string): string {
  return `${value.length}:${value}`;
}

export function canonicalInventoryLineageTransition(
  transition: InventoryLineageSemanticTransition,
): string {
  return [
    "inventory-asset-lineage-transition-v1",
    transition.asset_id,
    transition.origin_receipt_digest,
    transition.from_owner,
    transition.to_owner,
    transition.expected_version.toString(),
    transition.previous_event,
    transition.source_event,
    transition.previous_lineage_root,
  ].map(appendField).join("");
}

function textFieldValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function versionValid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function transitionStructurallyValid(
  transition: InventoryLineageSemanticTransition | null | undefined,
): transition is InventoryLineageSemanticTransition {
  return typeof transition === "object" && transition !== null &&
    textFieldValid(transition.asset_id) &&
    digestValid(transition.origin_receipt_digest) &&
    textFieldValid(transition.from_owner) &&
    textFieldValid(transition.to_owner) &&
    transition.from_owner !== transition.to_owner &&
    versionValid(transition.expected_version) &&
    textFieldValid(transition.previous_event) &&
    textFieldValid(transition.source_event) &&
    digestValid(transition.previous_lineage_root) &&
    digestValid(transition.next_lineage_root);
}

export async function verifyInventoryLineageSemantics(
  transcript: InventoryLineageSemanticTranscript,
  digest: AsyncInventoryLineageSemanticDigest,
): Promise<VerifyInventoryLineageSemanticsResult> {
  if (
    !textFieldValid(transcript.asset_id) ||
    !textFieldValid(transcript.current_owner_id) ||
    !textFieldValid(transcript.initial_owner_id) ||
    !versionValid(transcript.initial_version) ||
    !textFieldValid(transcript.initial_last_event) ||
    !digestValid(transcript.initial_lineage_root) ||
    !Number.isSafeInteger(transcript.transfer_count) ||
    transcript.transfer_count <= 0 ||
    transcript.transfer_count > 64 ||
    !Array.isArray(transcript.transitions) ||
    transcript.transitions.length !== transcript.transfer_count ||
    !textFieldValid(transcript.final_owner_id) ||
    !versionValid(transcript.final_version) ||
    !textFieldValid(transcript.final_last_event) ||
    !digestValid(transcript.final_lineage_root)
  ) {
    return { ok: false, reason: "invalid_transcript", transitionIndex: 0 };
  }

  let owner = transcript.initial_owner_id;
  let version = transcript.initial_version;
  let lastEvent = transcript.initial_last_event;
  let lineageRoot = transcript.initial_lineage_root;
  for (let index = 0; index < transcript.transitions.length; index++) {
    const transition = transcript.transitions[index];
    if (
      !transitionStructurallyValid(transition) ||
      transition.asset_id !== transcript.asset_id ||
      transition.from_owner !== owner ||
      transition.expected_version !== version ||
      transition.previous_event !== lastEvent ||
      transition.previous_lineage_root !== lineageRoot
    ) {
      return {
        ok: false,
        reason: "transition_mismatch",
        transitionIndex: index,
      };
    }
    owner = transition.to_owner;
    version += 1;
    lastEvent = transition.source_event;
    lineageRoot = transition.next_lineage_root;
  }
  if (
    owner !== transcript.final_owner_id ||
    owner !== transcript.current_owner_id ||
    version !== transcript.final_version ||
    lastEvent !== transcript.final_last_event ||
    lineageRoot !== transcript.final_lineage_root
  ) {
    return {
      ok: false,
      reason: "transition_mismatch",
      transitionIndex: transcript.transfer_count,
    };
  }

  const computedRoots = await Promise.all(
    transcript.transitions.map((transition) =>
      digest.hashString(canonicalInventoryLineageTransition(transition))
    ),
  );
  for (let index = 0; index < computedRoots.length; index++) {
    if (computedRoots[index] !== transcript.transitions[index].next_lineage_root) {
      return { ok: false, reason: "root_mismatch", transitionIndex: index };
    }
  }
  return { ok: true, transitionCount: transcript.transitions.length };
}
