import type { InventoryCheckpointCertificateAuthenticationTranscript } from "./inventory-checkpoint-certificate";
import type { InventoryCheckpointSemanticTranscript } from "./inventory-checkpoint-semantics";
import type { InventoryMembershipTranscript } from "./inventory-membership-semantics";
import type { InventoryOriginSemanticTranscript } from "./inventory-origin-semantics";
import type { OpenWorldMissingSlotTranscript } from "./open-world-missing-slot-semantics";
import type { DigestVerificationPlan } from "../../player-local-runtime/digest-verification-plan";
import type {
  KeyBoundAuthentication,
  VerificationKeyHistoryWire,
} from "../../player-local-runtime/key-lifecycle";

type AuditModule = typeof import("../../../_build/js/release/build/x/game_audit/worker/worker.js");

let auditModule: AuditModule | undefined;

const loadedCheckpointRuntime = Symbol("loaded-checkpoint-runtime");

export interface LoadedCheckpointRuntime {
  readonly [loadedCheckpointRuntime]: true;
}

export type OpenWorldObserverSigningDecision =
  | "sign_new"
  | "reuse_existing"
  | "reject_conflict"
  | "reject_invalid";

export interface OpenWorldObserverSigningStoreSnapshot {
  ok: true;
  root: string;
  size: number;
}

const loadedCheckpointRuntimeCapability: LoadedCheckpointRuntime = Object.freeze({
  [loadedCheckpointRuntime]: true as const,
});

function moonBitNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= 2_147_483_647;
}

async function loadAuditModule(): Promise<AuditModule> {
  auditModule ??= await import(
    "../../../_build/js/release/build/x/game_audit/worker/worker.js"
  );
  return auditModule;
}

export type AnchorHeadDecision =
  | "advance"
  | "duplicate"
  | "same_epoch_fork"
  | "wrong_parent_fork"
  | "gap"
  | "stale"
  | "boundary_rejected";

export type CentralReplayArtifactDecision =
  | "boundary_rejected"
  | "awaiting_transcript"
  | "checkpoint_link_rejected"
  | "replay_incomplete"
  | "replay_mismatch"
  | "verified";

export type CheckpointClosureDecision =
  | "ready"
  | "pending_missing_frontier"
  | "pending_under_quorum"
  | "conflict_equivocation"
  | "refused_invalid_evidence";

export interface CheckpointRuntimeBoundary {
  protocol_version: number;
  purpose: string;
  manifest_digest: string;
  scope_id: string;
  unit_id: string;
}

export interface CheckpointDeliveryWitness {
  witness_id: string;
  witness_key: string;
}

export interface CheckpointDeliveryAuthenticationPolicy {
  producer_id: string;
  producer_key: string;
  witnesses: CheckpointDeliveryWitness[];
  required_approvals: number;
  key_history?: VerificationKeyHistoryWire;
  legacy_accept_until_ms?: number;
  max_clock_skew_ms?: number;
}

export interface CheckpointDeliveryApproval {
  statement_digest: string;
  witness_id: string;
  witness_key: string;
  digest: string;
  signature: string;
  key_authentication?: KeyBoundAuthentication;
}

export interface CheckpointDeliveryAuthentication {
  version: 1 | 2;
  producer_id: string;
  producer_key: string;
  statement_digest: string;
  producer_signature: string;
  producer_key_authentication?: KeyBoundAuthentication;
  approvals: CheckpointDeliveryApproval[];
}

export type CheckpointDeliveryAuthenticationVerification =
  | { ok: true; producer_id: string; approval_count: number }
  | { ok: false; error: string };

export interface CheckpointDeliveryAuthenticationInput {
  boundary: CheckpointRuntimeBoundary;
  destinationId: string;
  epoch: number;
  previousCheckpoint: string;
  checkpointDigest: string;
  canonicalEnvelope: string;
  policy: CheckpointDeliveryAuthenticationPolicy;
  authentication: CheckpointDeliveryAuthentication;
}

export function sameCheckpointDeliveryAuthenticationPolicy(
  left: CheckpointDeliveryAuthenticationPolicy | undefined,
  right: CheckpointDeliveryAuthenticationPolicy | undefined,
): boolean {
  if (!left || !right) return left === right;
  const normalizeWitnesses = (
    witnesses: CheckpointDeliveryWitness[],
  ): Array<[string, string]> => witnesses
    .map((witness): [string, string] => [
      witness.witness_id,
      witness.witness_key,
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([
    left.producer_id,
    left.producer_key,
    left.required_approvals,
    normalizeWitnesses(left.witnesses),
    JSON.stringify(left.key_history ?? null),
    left.legacy_accept_until_ms ?? null,
    left.max_clock_skew_ms ?? null,
  ]) === JSON.stringify([
    right.producer_id,
    right.producer_key,
    right.required_approvals,
    normalizeWitnesses(right.witnesses),
    JSON.stringify(right.key_history ?? null),
    right.legacy_accept_until_ms ?? null,
    right.max_clock_skew_ms ?? null,
  ]);
}

export function sameCheckpointDeliveryAuthentication(
  left: CheckpointDeliveryAuthentication | undefined,
  right: CheckpointDeliveryAuthentication | undefined,
): boolean {
  if (!left || !right) return left === right;
  const normalizeApprovals = (
    approvals: CheckpointDeliveryApproval[],
  ): Array<[string, string, string, string, string, string]> => approvals
    .map((approval): [string, string, string, string, string, string] => [
      approval.statement_digest,
      approval.witness_id,
      approval.witness_key,
      approval.digest,
      approval.signature,
      JSON.stringify(approval.key_authentication ?? null),
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([
    left.version,
    left.producer_id,
    left.producer_key,
    left.statement_digest,
    left.producer_signature,
    JSON.stringify(left.producer_key_authentication ?? null),
    normalizeApprovals(left.approvals),
  ]) === JSON.stringify([
    right.version,
    right.producer_id,
    right.producer_key,
    right.statement_digest,
    right.producer_signature,
    JSON.stringify(right.producer_key_authentication ?? null),
    normalizeApprovals(right.approvals),
  ]);
}

export function sameCheckpointDeliveryApproval(
  left: CheckpointDeliveryApproval,
  right: CheckpointDeliveryApproval,
): boolean {
  return left.statement_digest === right.statement_digest &&
    left.witness_id === right.witness_id &&
    left.witness_key === right.witness_key &&
    left.digest === right.digest &&
    left.signature === right.signature &&
    JSON.stringify(left.key_authentication ?? null) ===
      JSON.stringify(right.key_authentication ?? null);
}

export interface StoredCheckpointClosure {
  epoch: number;
  roster_digest: string;
  frontier_digest: string;
  certificate_digest: string;
}

export interface PreparedCheckpointOutboxEntry {
  destination_id: string;
  epoch: number;
  checkpoint_digest: string;
  canonical_envelope: string;
  created_order: number;
}

export type AtomicCheckpointSealPreparation =
  | {
    decision: "prepared";
    epoch: number;
    digest: string;
    closure_epoch: number;
    next_outbox_entry_count: number;
    next_created_order: number;
    outbox: PreparedCheckpointOutboxEntry[];
  }
  | { decision: "duplicate" }
  | { decision: "conflict" | "refused"; reason: string };

export type CheckpointAckDecision =
  | "accepted"
  | "duplicate"
  | "gap"
  | "same_epoch_fork"
  | "parent_fork"
  | "stale_unknown"
  | "boundary_mismatch"
  | "refused";

export interface VerifiedAnchor {
  ok: true;
  session_id: string;
  publisher_key: string;
  epoch: number;
  digest: string;
  previous_digest: string;
  observer_id: string;
  anchor_root: string;
  anchor_size: number;
  envelope_bytes: number;
}

interface RefusedAnchor {
  ok: false;
  error: string;
}

export interface VerifiedPveReplay {
  ok: true;
  complete: true;
  session_id: string;
  authority_key: string;
  transparency_checkpoint_digest: string;
  checkpoint_digest: string;
  epoch: number;
  cleared: boolean;
  accepted_dodges: number;
  survivors: string[];
  defeated: string[];
  replayed_assets: number;
  bundle_bytes: number;
}

export interface RefusedPveReplay {
  ok: false;
  complete: boolean;
  error: string;
}

export type PveReplayVerification = VerifiedPveReplay | RefusedPveReplay;

export interface VerifiedPvpReplay {
  ok: true;
  complete: true;
  session_id: string;
  referee_key: string;
  checkpoint_digest: string;
  epoch: number;
  accepted_commands: number;
  approval_count: number;
  required_approvals: number;
  equivocators: string[];
  bundle_bytes: number;
}

export interface RefusedPvpReplay {
  ok: false;
  complete: boolean;
  error: string;
}

export type PvpReplayVerification = VerifiedPvpReplay | RefusedPvpReplay;

export interface VerifiedOpenWorldPveReplay {
  ok: true;
  complete: true;
  world_id: string;
  encounter_session_id: string;
  authority_key: string;
  transparency_checkpoint_digest: string;
  audit_checkpoint_digest: string;
  seal_checkpoint_digest: string;
  checkpoint_digest: string;
  observer_approvals: number;
  required_observer_approvals: number;
  cleared: boolean;
  accepted_dodges: number;
  survivors: string[];
  defeated: string[];
  verified_item_creations: VerifiedItemCreation[];
  bundle_bytes: number;
}

export interface VerifiedItemCreation {
  asset_id: string;
  initial_owner_id: string;
  item_type: string;
  quantity: number;
  output_index: number;
  source_event: string;
  checkpoint_digest: string;
  inventory_session_id: string;
  checkpoint_epoch: number;
}

export interface RefusedOpenWorldPveReplay {
  ok: false;
  complete: boolean;
  error: string;
}

export type OpenWorldPveReplayVerification =
  | VerifiedOpenWorldPveReplay
  | RefusedOpenWorldPveReplay;

export interface OpenWorldMissingSlotProofInput {
  expectedRegistryRoot: string;
  registeredCount: number;
  registrationIndex: number;
  proofEntryCount: number;
  directions: Array<"left" | "right">;
  parentKeys: string[];
  parentValues: string[];
  siblingDigests: string[];
}

export interface RefusedOpenWorldMissingSlotProof {
  ok: false;
  error: string;
}

export type OpenWorldMissingSlotProofVerification =
  | OpenWorldMissingSlotTranscript
  | RefusedOpenWorldMissingSlotProof;

export type OpenWorldMissingSlotEvidenceSource =
  | "authority_signed_encounter"
  | "observer_quorum";

export interface OpenWorldMissingSlotConflictInput {
  bundleHex: string;
  expectedWorldId: string;
  expectedAuthorityKey: string;
  expectedTransparencyLogSessionId: string;
  expectedTransparencyPublisherKey: string;
  expectedTransparencyCheckpointDigest: string;
  expectedAuditCheckpointDigest: string;
  expectedSealCheckpointDigest: string;
  expectedEncounterCheckpointDigest: string;
  expectedRegistrationIndex: number;
  evidenceSource: OpenWorldMissingSlotEvidenceSource;
}

export interface OpenWorldMissingSlotConflictTranscript
  extends OpenWorldMissingSlotTranscript {
  decision: "persist_conflict";
  kind: "missing_slot";
  source: OpenWorldMissingSlotEvidenceSource;
  audit_checkpoint_digest: string;
  seal_checkpoint_digest: string;
  encounter_digest: string;
  observer_approvals: number | null;
}

export type OpenWorldMissingSlotConflictVerification =
  | OpenWorldMissingSlotConflictTranscript
  | RefusedOpenWorldMissingSlotProof;

export interface VerifiedInventoryListing {
  ok: true;
  complete: true;
  session_id: string;
  authority_key: string;
  checkpoint_digest: string;
  previous_checkpoint: string;
  epoch: number;
  public_state_root: string;
  asset_id: string;
  current_owner_id: string;
  version: number;
  last_event: string;
  lineage_root: string;
  approval_count: number;
  required_approvals: number;
  checkpoint_authentication: InventoryCheckpointCertificateAuthenticationTranscript;
  checkpoint_semantics: InventoryCheckpointSemanticTranscript;
  inventory_origins: InventoryOriginSemanticTranscript;
  inventory_membership: InventoryMembershipTranscript;
  bundle_bytes: number;
}

export interface RefusedInventoryListing {
  ok: false;
  complete: boolean;
  error: string;
}

export type InventoryListingVerification =
  | VerifiedInventoryListing
  | RefusedInventoryListing;

export interface ExpectedInventoryCheckpointAsset {
  asset_id: string;
  initial_owner_id: string;
  item_type: string;
  quantity: number;
  source_event: string;
  output_index: number;
  current_owner_id: string;
  current_version: number;
  current_checkpoint_digest: string;
  current_epoch: number;
  creation_eligible: boolean;
  lineage_clean: boolean;
}

export interface VerifiedInventoryCheckpointAsset {
  asset_id: string;
  current_owner_id: string;
  version: number;
  last_event: string;
  lineage_root: string;
}

export interface VerifiedInventoryCheckpoint {
  ok: true;
  complete: true;
  session_id: string;
  authority_key: string;
  checkpoint_digest: string;
  previous_checkpoint: string;
  epoch: number;
  game_manifest_digest: string;
  public_state_root: string;
  asset_count: number;
  assets: VerifiedInventoryCheckpointAsset[];
  write_set_digest: string;
  approval_count: number;
  required_approvals: number;
  checkpoint_authentication: InventoryCheckpointCertificateAuthenticationTranscript;
  checkpoint_semantics: InventoryCheckpointSemanticTranscript;
  inventory_origins: InventoryOriginSemanticTranscript;
  inventory_membership: InventoryMembershipTranscript;
  bundle_bytes: number;
}

export interface RefusedInventoryCheckpoint {
  ok: false;
  complete: boolean;
  error: string;
}

export type InventoryCheckpointVerification =
  | VerifiedInventoryCheckpoint
  | RefusedInventoryCheckpoint;

export interface VerifiedInventoryLineageTransition {
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

export type InventoryLineageAuthenticationCheckKind =
  | "sender_binding"
  | "recipient_binding"
  | "sender_transfer"
  | "recipient_transfer";

export interface InventoryLineageAuthenticationCheck {
  kind: InventoryLineageAuthenticationCheckKind;
  transfer_index: number;
  public_key: string;
  canonical_statement: string;
  digest: string;
  signature: string;
}

export interface VerifiedInventoryLineage extends DigestVerificationPlan {
  ok: true;
  complete: true;
  checkpoint_digest: string;
  asset_id: string;
  current_owner_id: string;
  public_state_root: string;
  initial_owner_id: string;
  initial_version: number;
  initial_last_event: string;
  initial_lineage_root: string;
  initial_origin_receipt_digest: string;
  transfer_count: number;
  transfer_events: string[];
  transitions: VerifiedInventoryLineageTransition[];
  authentication_checks: InventoryLineageAuthenticationCheck[];
  checkpoint_authentication: InventoryCheckpointCertificateAuthenticationTranscript;
  checkpoint_semantics: InventoryCheckpointSemanticTranscript;
  inventory_origins: InventoryOriginSemanticTranscript;
  inventory_membership: InventoryMembershipTranscript;
  final_owner_id: string;
  final_version: number;
  final_last_event: string;
  final_lineage_root: string;
  bundle_bytes: number;
}

export interface RefusedInventoryLineage {
  ok: false;
  complete: boolean;
  error: string;
}

export type InventoryLineageVerification =
  | VerifiedInventoryLineage
  | RefusedInventoryLineage;

export async function verifyAnchorEnvelope(
  envelopeHex: string,
  authorityKey: string,
  sessionId: string,
): Promise<VerifiedAnchor | RefusedAnchor> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_anchor_envelope(envelopeHex, authorityKey, sessionId),
  ) as VerifiedAnchor | RefusedAnchor;
}

export async function openCheckpointClosure(input: {
  boundary: CheckpointRuntimeBoundary;
  closure: StoredCheckpointClosure;
  frontierComplete: boolean;
  conflictFree: boolean;
  quorumSatisfied: boolean;
}): Promise<CheckpointClosureDecision> {
  const audit = await loadAuditModule();
  return audit.audit_open_checkpoint_closure(
    input.boundary.protocol_version,
    input.boundary.purpose,
    input.boundary.manifest_digest,
    input.boundary.scope_id,
    input.boundary.unit_id,
    input.closure.epoch,
    input.closure.roster_digest,
    input.closure.frontier_digest,
    input.closure.certificate_digest,
    input.frontierComplete,
    input.conflictFree,
    input.quorumSatisfied,
  ) as CheckpointClosureDecision;
}

export async function loadCheckpointRuntime(): Promise<LoadedCheckpointRuntime> {
  await loadAuditModule();
  return loadedCheckpointRuntimeCapability;
}

export function classifyOpenWorldObserverSigningSync(
  runtime: LoadedCheckpointRuntime,
  input: {
    targetValid: boolean;
    previousObservationPresent: boolean;
    previousDigestMatches: boolean;
  },
): OpenWorldObserverSigningDecision {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before observer signing");
  }
  return auditModule.audit_classify_open_world_observer_signing(
    input.targetValid,
    input.previousObservationPresent,
    input.previousDigestMatches,
  ) as OpenWorldObserverSigningDecision;
}

export function openWorldObserverSigningKeySync(
  runtime: LoadedCheckpointRuntime,
  auditCheckpointDigest: string,
  registrationIndex: number,
): string {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before observer signing");
  }
  return auditModule.audit_open_world_observer_signing_key(
    auditCheckpointDigest,
    registrationIndex,
  );
}

export function openWorldObserverSigningStoreSnapshotSync(
  runtime: LoadedCheckpointRuntime,
  records: ReadonlyArray<{ signingKey: string; encounterDigest: string }>,
): OpenWorldObserverSigningStoreSnapshot {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before observer signing");
  }
  const result = JSON.parse(
    auditModule.audit_open_world_observer_signing_store_snapshot(
      records.map((record) => record.signingKey),
      records.map((record) => record.encounterDigest),
    ),
  ) as OpenWorldObserverSigningStoreSnapshot | { ok: false; error: string };
  if (!result.ok) {
    throw new Error(`MoonBit observer signing snapshot refused: ${result.error}`);
  }
  return result;
}

export function verifyCheckpointDeliveryAuthenticationSync(
  runtime: LoadedCheckpointRuntime,
  input: CheckpointDeliveryAuthenticationInput,
): CheckpointDeliveryAuthenticationVerification {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before authentication");
  }
  const { boundary, policy, authentication } = input;
  if (authentication.version !== 1) {
    return { ok: false, error: "unsupported_authentication_version" };
  }
  return JSON.parse(
    auditModule.audit_verify_checkpoint_delivery_authentication(
      boundary.protocol_version,
      boundary.purpose,
      boundary.manifest_digest,
      boundary.scope_id,
      boundary.unit_id,
      input.destinationId,
      input.epoch,
      input.previousCheckpoint,
      input.checkpointDigest,
      input.canonicalEnvelope,
      policy.producer_id,
      policy.producer_key,
      policy.witnesses.map((witness) => witness.witness_id),
      policy.witnesses.map((witness) => witness.witness_key),
      policy.required_approvals,
      authentication.producer_id,
      authentication.producer_key,
      authentication.statement_digest,
      authentication.producer_signature,
      authentication.approvals.map((approval) => approval.statement_digest),
      authentication.approvals.map((approval) => approval.witness_id),
      authentication.approvals.map((approval) => approval.witness_key),
      authentication.approvals.map((approval) => approval.digest),
      authentication.approvals.map((approval) => approval.signature),
    ),
  ) as CheckpointDeliveryAuthenticationVerification;
}

export function serializeCheckpointDeliveryStatementSync(
  runtime: LoadedCheckpointRuntime,
  input: Omit<
    CheckpointDeliveryAuthenticationInput,
    "policy" | "authentication"
  >,
): string {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error(
      "MoonBit checkpoint runtime must be loaded before serialization",
    );
  }
  const { boundary } = input;
  return auditModule.audit_serialize_checkpoint_delivery_statement(
    boundary.protocol_version,
    boundary.purpose,
    boundary.manifest_digest,
    boundary.scope_id,
    boundary.unit_id,
    input.destinationId,
    input.epoch,
    input.previousCheckpoint,
    input.checkpointDigest,
    input.canonicalEnvelope,
  );
}

export function serializeCheckpointDeliveryApprovalSync(
  runtime: LoadedCheckpointRuntime,
  statementDigest: string,
  witnessId: string,
): string {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error(
      "MoonBit checkpoint runtime must be loaded before serialization",
    );
  }
  return auditModule.audit_serialize_checkpoint_delivery_approval(
    statementDigest,
    witnessId,
  );
}

export function prepareCheckpointSealSync(
  runtime: LoadedCheckpointRuntime,
  input: {
  boundary: CheckpointRuntimeBoundary;
  closure: StoredCheckpointClosure;
  currentEpoch: number;
  currentDigest: string;
  incomingEpochKnown: boolean;
  knownDigestMatches: boolean;
  knownSealComplete: boolean;
  closureConsumed: boolean;
  outboxEntryCount: number;
  outboxCapacity: number;
  nextCreatedOrder: number;
  checkpointEpoch: number;
  previousCheckpoint: string;
  checkpointDigest: string;
  canonicalEnvelope: string;
  destinations: string[];
  },
): AtomicCheckpointSealPreparation {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before transaction");
  }
  return JSON.parse(
    auditModule.audit_prepare_atomic_checkpoint_seal(
      input.boundary.protocol_version,
      input.boundary.purpose,
      input.boundary.manifest_digest,
      input.boundary.scope_id,
      input.boundary.unit_id,
      input.closure.epoch,
      input.closure.roster_digest,
      input.closure.frontier_digest,
      input.closure.certificate_digest,
      input.currentEpoch,
      input.currentDigest,
      input.incomingEpochKnown,
      input.knownDigestMatches,
      input.knownSealComplete,
      input.closureConsumed,
      input.outboxEntryCount,
      input.outboxCapacity,
      input.nextCreatedOrder,
      input.checkpointEpoch,
      input.previousCheckpoint,
      input.checkpointDigest,
      input.canonicalEnvelope,
      input.destinations,
    ),
  ) as AtomicCheckpointSealPreparation;
}

export function acknowledgeCheckpointOutboxSync(
  runtime: LoadedCheckpointRuntime,
  input: {
  boundary: CheckpointRuntimeBoundary;
  destinationId: string;
  epoch: number;
  checkpointDigest: string;
  canonicalEnvelope: string;
  createdOrder: number;
  ackBoundary: CheckpointRuntimeBoundary;
  ackAuthorityId: string;
  ackEpoch: number;
  ackCheckpointDigest: string;
  ackDecision: CheckpointAckDecision;
  authenticationSucceeded: boolean;
  },
): string {
  if (runtime !== loadedCheckpointRuntimeCapability || !auditModule) {
    throw new Error("MoonBit checkpoint runtime must be loaded before transaction");
  }
  return auditModule.audit_acknowledge_checkpoint_outbox(
    input.boundary.protocol_version,
    input.boundary.purpose,
    input.boundary.manifest_digest,
    input.boundary.scope_id,
    input.boundary.unit_id,
    input.destinationId,
    input.epoch,
    input.checkpointDigest,
    input.canonicalEnvelope,
    input.createdOrder,
    input.ackBoundary.protocol_version,
    input.ackBoundary.purpose,
    input.ackBoundary.manifest_digest,
    input.ackBoundary.scope_id,
    input.ackBoundary.unit_id,
    input.ackAuthorityId,
    input.ackEpoch,
    input.ackCheckpointDigest,
    input.ackDecision,
    input.authenticationSucceeded,
  );
}

export function classifyAnchorHead(input: {
  boundaryMatches: boolean;
  epochKnown: boolean;
  knownDigestMatches: boolean;
  currentEpoch: number;
  incomingEpoch: number;
  parentMatches: boolean;
}): AnchorHeadDecision {
  if (!auditModule) {
    throw new Error("MoonBit audit module must be loaded before classification");
  }
  return auditModule.audit_classify_anchor_head(
    input.boundaryMatches,
    input.epochKnown,
    input.knownDigestMatches,
    input.currentEpoch,
    input.incomingEpoch,
    input.parentMatches,
  ) as AnchorHeadDecision;
}

export async function classifyCentralReplayArtifacts(input: {
  anchorMatchesJob: boolean;
  transcriptPresent: boolean;
  checkpointLinkValid: boolean;
  kernelReplayComplete: boolean;
  kernelReplayMatches: boolean;
}): Promise<CentralReplayArtifactDecision> {
  const audit = await loadAuditModule();
  return audit.audit_classify_central_replay(
    input.anchorMatchesJob,
    input.transcriptPresent,
    input.checkpointLinkValid,
    input.kernelReplayComplete,
    input.kernelReplayMatches,
  ) as CentralReplayArtifactDecision;
}

export async function marketplaceCreationPersistAllowed(input: {
  openWorldBoundary: boolean;
  centralReplayVerified: boolean;
  summaryNormalized: boolean;
  checkpointBound: boolean;
  conflictFree: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_marketplace_creation_persist_allowed(
    input.openWorldBoundary,
    input.centralReplayVerified,
    input.summaryNormalized,
    input.checkpointBound,
    input.conflictFree,
  );
}

export async function openWorldMissingSlotPersistAllowed(input: {
  conflictCapabilityIssued: boolean;
  standardNonMembershipVerified: boolean;
  exactTranscriptBinding: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_open_world_missing_slot_persist_allowed(
    input.conflictCapabilityIssued,
    input.standardNonMembershipVerified,
    input.exactTranscriptBinding,
  );
}

export async function inventoryHeadAdvanceAllowed(input: {
  creationEligible: boolean;
  proofVerified: boolean;
  manifestMatches: boolean;
  parentMatches: boolean;
  epochAdvances: boolean;
  ownerVersionConsistent: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_inventory_head_advance_allowed(
    input.creationEligible,
    input.proofVerified,
    input.manifestMatches,
    input.parentMatches,
    input.epochAdvances,
    input.ownerVersionConsistent,
  );
}

export async function assetLineageUseAllowed(input: {
  creationVerified: boolean;
  currentHeadVerified: boolean;
  openRevocations: number;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_asset_lineage_use_allowed(
    input.creationVerified,
    input.currentHeadVerified,
    input.openRevocations,
  );
}

export async function assetLineageDecisionAllowed(input: {
  assetExists: boolean;
  ancestorInLineage: boolean;
  expectedDecisionMatches: boolean;
  revisionAdvances: boolean;
  decisionChangesStatus: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_asset_lineage_decision_allowed(
    input.assetExists,
    input.ancestorInLineage,
    input.expectedDecisionMatches,
    input.revisionAdvances,
    input.decisionChangesStatus,
  );
}

export async function assetLineageCertificateAllowed(input: {
  certificateAuthenticated: boolean;
  arbiterKnown: boolean;
  lineageBound: boolean;
  certificateTimeValid: boolean;
  lifecycleValid: boolean;
  isAppeal: boolean;
  appealTargetMatches: boolean;
  appealWindowOpen: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_asset_lineage_certificate_allowed(
    input.certificateAuthenticated,
    input.arbiterKnown,
    input.lineageBound,
    input.certificateTimeValid,
    input.lifecycleValid,
    input.isAppeal,
    input.appealTargetMatches,
    input.appealWindowOpen,
  );
}

export async function evidenceLineageCaseAdmissionAllowed(input: {
  activeHold: boolean;
  boundaryMatches: boolean;
  checkpointMatches: boolean;
  referenceMatches: boolean;
  ancestorMatches: boolean;
  authenticationSucceeded: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_evidence_lineage_case_admission_allowed(
    input.activeHold,
    input.boundaryMatches,
    input.checkpointMatches,
    input.referenceMatches,
    input.ancestorMatches,
    input.authenticationSucceeded,
  );
}

export async function evidenceLineageCaseDecisionAllowed(input: {
  caseOpen: boolean;
  assetMatches: boolean;
  ancestorMatches: boolean;
  certificateAuthenticated: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_evidence_lineage_case_decision_allowed(
    input.caseOpen,
    input.assetMatches,
    input.ancestorMatches,
    input.certificateAuthenticated,
  );
}

export async function evidenceLineageCaseDismissalAllowed(input: {
  caseOpen: boolean;
  caseIdMatches: boolean;
  certificateAuthenticated: boolean;
  certificateTimeValid: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_evidence_lineage_case_dismissal_allowed(
    input.caseOpen,
    input.caseIdMatches,
    input.certificateAuthenticated,
    input.certificateTimeValid,
  );
}

export async function evidenceCaseSourceResolutionAllowed(input: {
  caseResolved: boolean;
  resolutionMatches: boolean;
  sourceAuthenticated: boolean;
  cursorMatches: boolean;
}): Promise<boolean> {
  const audit = await loadAuditModule();
  return audit.audit_evidence_case_source_resolution_allowed(
    input.caseResolved,
    input.resolutionMatches,
    input.sourceAuthenticated,
    input.cursorMatches,
  );
}

export async function verifyPveReplayBundle(
  bundleHex: string,
  expectedSessionId: string,
  expectedAuthorityKey: string,
  expectedCheckpointDigest: string,
): Promise<PveReplayVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_pve_replay_bundle(
      bundleHex,
      expectedSessionId,
      expectedAuthorityKey,
      expectedCheckpointDigest,
    ),
  ) as PveReplayVerification;
}

export async function verifyPvpReplayBundle(
  bundleHex: string,
  expectedSessionId: string,
  expectedRefereeKey: string,
  expectedCheckpointDigest: string,
): Promise<PvpReplayVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_pvp_replay_bundle(
      bundleHex,
      expectedSessionId,
      expectedRefereeKey,
      expectedCheckpointDigest,
    ),
  ) as PvpReplayVerification;
}

export async function verifyOpenWorldPveReplayBundle(
  bundleHex: string,
  expectedWorldId: string,
  expectedEncounterSessionId: string,
  expectedAuthorityKey: string,
  expectedTransparencyLogSessionId: string,
  expectedTransparencyPublisherKey: string,
  expectedTransparencyCheckpointDigest: string,
  expectedAuditCheckpointDigest: string,
  expectedSealCheckpointDigest: string,
  expectedEncounterCheckpointDigest: string,
): Promise<OpenWorldPveReplayVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_open_world_pve_replay_bundle(
      bundleHex,
      expectedWorldId,
      expectedEncounterSessionId,
      expectedAuthorityKey,
      expectedTransparencyLogSessionId,
      expectedTransparencyPublisherKey,
      expectedTransparencyCheckpointDigest,
      expectedAuditCheckpointDigest,
      expectedSealCheckpointDigest,
      expectedEncounterCheckpointDigest,
    ),
  ) as OpenWorldPveReplayVerification;
}

export async function openWorldEncounterRegistrationKey(
  registrationIndex: number,
): Promise<string> {
  if (!moonBitNonNegativeInt(registrationIndex)) return "";
  const audit = await loadAuditModule();
  return audit.audit_open_world_encounter_registration_key(registrationIndex);
}

/**
 * Open the authenticated-map absence half of missing-slot evidence in MoonBit.
 * This does not authenticate the signed seal or the encounter/observer claim.
 */
export async function verifyOpenWorldMissingSlotProof(
  input: OpenWorldMissingSlotProofInput,
): Promise<OpenWorldMissingSlotProofVerification> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "invalid_non_membership_shape" };
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedRegistryRoot)) {
    return { ok: false, error: "invalid_expected_registry_root" };
  }
  if (!Array.isArray(input.directions)) {
    return { ok: false, error: "invalid_non_membership_shape" };
  }
  const pathLength = input.directions.length;
  if (
    !moonBitNonNegativeInt(input.registeredCount) ||
    input.registeredCount <= 0 ||
    !moonBitNonNegativeInt(input.registrationIndex) ||
    input.registrationIndex >= input.registeredCount ||
    !moonBitNonNegativeInt(input.proofEntryCount) || pathLength > 64 ||
    !Array.isArray(input.parentKeys) || input.parentKeys.length !== pathLength ||
    !Array.isArray(input.parentValues) ||
    input.parentValues.length !== pathLength ||
    !Array.isArray(input.siblingDigests) ||
    input.siblingDigests.length !== pathLength
  ) {
    return { ok: false, error: "invalid_non_membership_shape" };
  }
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_open_world_missing_slot_proof(
      input.expectedRegistryRoot,
      input.registeredCount,
      input.registrationIndex,
      input.proofEntryCount,
      input.directions,
      input.parentKeys,
      input.parentValues,
      input.siblingDigests,
    ),
  ) as OpenWorldMissingSlotProofVerification;
}

/**
 * Open a missing-slot accusation only after authenticating the signed
 * audit/seal boundary and one independently authenticated left-hand source.
 * The successful transcript must still be recomputed with standard host
 * crypto before a mutation is allowed.
 */
export async function openWorldMissingSlotConflict(
  input: OpenWorldMissingSlotConflictInput,
): Promise<OpenWorldMissingSlotConflictVerification> {
  const digestValid = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const boundedText = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 4_096;
  if (
    typeof input !== "object" || input === null ||
    typeof input.bundleHex !== "string" || input.bundleHex.length === 0 ||
    input.bundleHex.length > 2_097_152 || input.bundleHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(input.bundleHex) ||
    !boundedText(input.expectedWorldId) ||
    !boundedText(input.expectedTransparencyLogSessionId) ||
    !digestValid(input.expectedAuthorityKey) ||
    !digestValid(input.expectedTransparencyPublisherKey) ||
    !digestValid(input.expectedTransparencyCheckpointDigest) ||
    !digestValid(input.expectedAuditCheckpointDigest) ||
    !digestValid(input.expectedSealCheckpointDigest) ||
    !digestValid(input.expectedEncounterCheckpointDigest) ||
    !moonBitNonNegativeInt(input.expectedRegistrationIndex) ||
    input.expectedRegistrationIndex >= 2_147_483_647 ||
    (input.evidenceSource !== "authority_signed_encounter" &&
      input.evidenceSource !== "observer_quorum")
  ) {
    return { ok: false, error: "invalid_missing_slot_conflict_input" };
  }
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_open_world_missing_slot_conflict(
      input.bundleHex,
      input.expectedWorldId,
      input.expectedAuthorityKey,
      input.expectedTransparencyLogSessionId,
      input.expectedTransparencyPublisherKey,
      input.expectedTransparencyCheckpointDigest,
      input.expectedAuditCheckpointDigest,
      input.expectedSealCheckpointDigest,
      input.expectedEncounterCheckpointDigest,
      input.expectedRegistrationIndex,
      input.evidenceSource,
    ),
  ) as OpenWorldMissingSlotConflictVerification;
}

export async function verifyInventoryListingProofBundle(
  bundleHex: string,
  expectedSessionId: string,
  expectedAuthorityKey: string,
  expectedCheckpointDigest: string,
  expectedGameManifestDigest: string,
  expectedAssetId: string,
  expectedInitialOwnerId: string,
  expectedItemType: string,
  expectedQuantity: number,
  expectedSourceEvent: string,
  expectedOutputIndex: number,
  expectedSellerId: string,
  rejectedAncestor: boolean,
): Promise<InventoryListingVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_inventory_listing_proof_bundle(
      bundleHex,
      expectedSessionId,
      expectedAuthorityKey,
      expectedCheckpointDigest,
      expectedGameManifestDigest,
      expectedAssetId,
      expectedInitialOwnerId,
      expectedItemType,
      expectedQuantity,
      expectedSourceEvent,
      expectedOutputIndex,
      expectedSellerId,
      rejectedAncestor,
    ),
  ) as InventoryListingVerification;
}

export async function verifyInventoryCheckpointProofBundle(
  bundleHex: string,
  expectedSessionId: string,
  expectedAuthorityKey: string,
  expectedCheckpointDigest: string,
  expectedGameManifestDigest: string,
  expectedAssets: ExpectedInventoryCheckpointAsset[],
): Promise<InventoryCheckpointVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_inventory_checkpoint_proof_bundle(
      bundleHex,
      expectedSessionId,
      expectedAuthorityKey,
      expectedCheckpointDigest,
      expectedGameManifestDigest,
      expectedAssets.map((asset) => asset.asset_id),
      expectedAssets.map((asset) => asset.initial_owner_id),
      expectedAssets.map((asset) => asset.item_type),
      expectedAssets.map((asset) => asset.quantity),
      expectedAssets.map((asset) => asset.source_event),
      expectedAssets.map((asset) => asset.output_index),
      expectedAssets.map((asset) => asset.current_owner_id),
      expectedAssets.map((asset) => asset.current_version),
      expectedAssets.map((asset) => asset.current_checkpoint_digest),
      expectedAssets.map((asset) => asset.current_epoch),
      expectedAssets.map((asset) => asset.creation_eligible),
      expectedAssets.map((asset) => asset.lineage_clean),
    ),
  ) as InventoryCheckpointVerification;
}

export async function verifyInventoryLineageProofBundle(
  bundleHex: string,
  expectedSessionId: string,
  expectedAuthorityKey: string,
  expectedCheckpointDigest: string,
  expectedGameManifestDigest: string,
  expectedAssetId: string,
  expectedInitialOwnerId: string,
  expectedItemType: string,
  expectedQuantity: number,
  expectedSourceEvent: string,
  expectedOutputIndex: number,
  expectedSellerId: string,
  expectedAnchorOwnerId: string,
  expectedAnchorVersion: number,
  expectedAnchorLastEvent: string,
  expectedAnchorLineageRoot: string,
): Promise<InventoryLineageVerification> {
  const audit = await loadAuditModule();
  return JSON.parse(
    audit.audit_verify_inventory_lineage_proof_bundle(
      bundleHex,
      expectedSessionId,
      expectedAuthorityKey,
      expectedCheckpointDigest,
      expectedGameManifestDigest,
      expectedAssetId,
      expectedInitialOwnerId,
      expectedItemType,
      expectedQuantity,
      expectedSourceEvent,
      expectedOutputIndex,
      expectedSellerId,
      expectedAnchorOwnerId,
      expectedAnchorVersion,
      expectedAnchorLastEvent,
      expectedAnchorLineageRoot,
    ),
  ) as InventoryLineageVerification;
}
