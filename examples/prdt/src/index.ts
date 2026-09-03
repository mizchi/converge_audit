// Core
export { canonicalize, toCanonicalJson, type JsonValue } from "./core/canonical.ts";
export { arrayCodec, bytesCodec, jsonCodec, mapCodec, type Codec } from "./core/codec.ts";
export { hashValue, sha256, sha256Hasher, type Hasher } from "./core/hash.ts";
export { commandId, type CommandId, type Envelope, type Hash, type ReplicaId, type Tick } from "./core/ids.ts";
export { lessOrEqual, mapLattice, setLattice, type JoinSemilattice } from "./core/lattice.ts";
export { canonicalOrder, composeOrder, sortCommands, type CommandOrder } from "./core/order.ts";
export type { ResolvedCommand, Verdict } from "./core/verdict.ts";
// Domain + finalization
export { accept, reject, type Accepted, type Domain, type Rejected, type Validation } from "./domain/domain.ts";
export { resolveBatch, type BatchHashing, type ResolvedBatch } from "./domain/resolve-batch.ts";
// PRDT
export { closureCertificateCodec, closureDecisionLattice, closureMapLattice, type ClosureCertificate, type ClosureDecision } from "./prdt/closure.ts";
export { committedLogLattice, isPrefixOf, type CommittedBatch, type CommittedLog } from "./prdt/committed-log.ts";
export { ProtocolError, isProtocolError, type ProtocolErrorKind } from "./prdt/errors.ts";
export { decisionLessOrEqual, latticeLawViolations, logsArePrefixCompatible } from "./prdt/laws.ts";
export { addProposal, emptyProposals, proposalLattice, proposalsForTick, type ProposalState } from "./prdt/proposal-state.ts";
export {
  ReplicatedDomain,
  createProtocol,
  createReplicatedDomain,
  type CommandDecision,
  type Decision,
  type Delta,
  type ReplicatedDomainConfig,
  type ReplicatedDomainProtocol,
  type ReplicatedDomainState,
} from "./prdt/replicated-domain.ts";
// Finalizers
export { closureMessage, sharedSecretAuthenticator, type Finalizer, type Signer, type Verifier } from "./finalizer/finalizer.ts";
export { createSingleAuthority, createSingleAuthorityFinalizer, type ClosureAuthority } from "./finalizer/single-authority.ts";
export { assembleQuorumCertificate, createQuorumFinalizer, createVoter, type QuorumRoster } from "./finalizer/quorum.ts";
export { addVote, emptyVotes, tallyVotes, voteLattice, type ClosureVote, type VoteState } from "./finalizer/vote-state.ts";
// Runtime
export * from "./runtime/index.ts";
