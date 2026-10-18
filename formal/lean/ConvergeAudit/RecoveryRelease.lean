import ConvergeAudit.Generations

namespace ConvergeAudit.RecoveryRelease
open Generations

/-- Fixed authority, owner and unit are implicit. `released` means an authenticated
 * owner request, never an elapsed timeout. A terminal record with no receipt
 * models a forfeit; even a zero-item settlement has `some receipt`. -/
def MayForget (generation : Nat) (released : Nat → Bool) (r : Record) : Prop :=
  r.receipt = none ∧ r.terminal = true ∧ r.retired = true ∧ r.held = false ∧
  released r.ticket = true ∧ r.start.generation < generation
instance (generation : Nat) (released : Nat → Bool) (r : Record) :
    Decidable (MayForget generation released r) := by unfold MayForget; infer_instance

/-- `rows` is a chosen finite batch. Runtime uses the closing hot generation
 * (at most 1024 rows), or one old row on late release; no whole-history scan
 * is required. `collected` below is an abstract state-level safety transform,
 * not a complexity model for a SQL query. -/
def collect (generation : Nat) (released : Nat → Bool) (rows : List Record) : List Record :=
  rows.filter (fun r => decide (¬ MayForget generation released r))
def collected (released : Nat → Bool) (s : State) : State :=
  { s with cold := collect s.generation released s.cold }

theorem retained_iff (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record) :
    r ∈ collect g ack rows ↔ r ∈ rows ∧ ¬ MayForget g ack r := by simp [collect]

theorem removed_requires_every_guard (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (removed : r ∉ collect g ack rows) : MayForget g ack r := by
  by_cases allowed : MayForget g ack r
  · exact allowed
  · exact False.elim (removed ((retained_iff g ack rows r).mpr ⟨present, allowed⟩))

theorem collect_preserves_receipt_sources (g : Nat) (ack : Nat → Bool) (rows : List Record) :
    (collect g ack rows).filterMap (fun r => r.receipt.map (fun _ => source r)) =
      rows.filterMap (fun r => r.receipt.map (fun _ => source r)) := by
  induction rows with
  | nil => rfl
  | cons r rest ih =>
    by_cases allowed : MayForget g ack r
    · have empty := allowed.1
      simpa [collect, allowed, empty] using ih
    · cases receipt : r.receipt with
      | none => simpa [collect, allowed, List.filterMap_cons, receipt] using ih
      | some id => simpa [collect, allowed, List.filterMap_cons, receipt] using congrArg (List.cons (source r)) ih

theorem receipt_survives (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (receipt : r.receipt ≠ none) : r ∈ collect g ack rows := by
  exact (retained_iff g ack rows r).mpr ⟨present, fun allowed => receipt allowed.1⟩

theorem unacknowledged_survives (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (unacknowledged : ack r.ticket = false) : r ∈ collect g ack rows := by
  apply (retained_iff g ack rows r).mpr; refine ⟨present, ?_⟩
  intro allowed; have := allowed.2.2.2.2.1; simp_all

theorem held_survives (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (held : r.held = true) : r ∈ collect g ack rows := by
  apply (retained_iff g ack rows r).mpr; refine ⟨present, ?_⟩
  intro allowed; have := allowed.2.2.2.1; simp_all

theorem retention_survives (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (retained : r.retired = false) : r ∈ collect g ack rows := by
  apply (retained_iff g ack rows r).mpr; refine ⟨present, ?_⟩
  intro allowed; have := allowed.2.2.1; simp_all

theorem current_generation_survives (g : Nat) (ack : Nat → Bool) (rows : List Record) (r : Record)
    (present : r ∈ rows) (current : g ≤ r.start.generation) : r ∈ collect g ack rows := by
  apply (retained_iff g ack rows r).mpr; refine ⟨present, ?_⟩
  intro allowed; have := allowed.2.2.2.2.2; omega

theorem collect_idempotent (g : Nat) (ack : Nat → Bool) (rows : List Record) :
    collect g ack (collect g ack rows) = collect g ack rows := by simp [collect, List.filter_filter]

theorem collect_never_grows (g : Nat) (ack : Nat → Bool) (rows : List Record) :
    (collect g ack rows).length ≤ rows.length := List.length_filter_le _ _

theorem all_disposable_leaves_no_tombstones (g : Nat) (ack : Nat → Bool) (rows : List Record)
    (all : ∀ r ∈ rows, MayForget g ack r) : collect g ack rows = [] := by
  apply List.eq_nil_iff_forall_not_mem.mpr
  intro r member
  have retained := (retained_iff g ack rows r).mp member
  exact retained.2 (all r retained.1)

theorem collection_preserves_generation_fences (ack : Nat → Bool) (s : State) :
    (collected ack s).generation = s.generation ∧ (collected ack s).archiveFloor = s.archiveFloor ∧
      (collected ack s).lastClosed = s.lastClosed := ⟨rfl, rfl, rfl⟩

theorem deleted_start_cannot_reissue (ack : Nat → Bool) (s : State) (r : Record) (ticket secret : Nat)
    (deleted : MayForget s.generation ack r) : issue r.start ticket secret (collected ack s) = none :=
  old_generation_cannot_issue r.start ticket secret (collected ack s) deleted.2.2.2.2.2

theorem collection_preserves_hot_bound (ack : Nat → Bool) (s : State) (bound : Bounded s) :
    Bounded (collected ack s) := bound

theorem fresh_roll_then_collection_blocks_old_start (expected : Nat) (s t : State) (ack : Nat → Bool)
    (a : Start) (ticket secret : Nat) (same : expected = s.generation) (old : a.generation ≤ s.generation)
    (accepted : roll expected s = some t) : issue a ticket secret (collected ack t) = none := by
  have advanced := (fresh_roll_advances expected s t same accepted).1
  apply old_generation_cannot_issue; change a.generation < t.generation; omega

/-- Crypto verification of this exact immutable proof, matching owner and unit,
 * is a host assumption. The model does not prove Ed25519 or SQL refinement. -/
structure Proof where
  ticket : Nat
  termination : Nat
  generation : Nat
  deriving DecidableEq, Repr
structure Client where
  proof : Option Proof
  payloadPresent : Bool
  pending : Bool
  deriving DecidableEq, Repr
def prepare (c : Client) : Option Client :=
  if c.proof.isSome ∧ c.payloadPresent = false then some { c with pending := true } else none
def adopt (ackValid : Bool) (c : Client) : Option Client :=
  if ackValid = true ∧ c.pending = true then some { c with proof := none, pending := false } else none

/-- If the row is absent, a verified original termination and a strictly newer
 * durable generation allow exact retry. Missing current-generation rows fail. -/
def retryWithoutRow (current : Nat) (authenticated : Bool) (p : Proof) : Bool :=
  authenticated && decide (p.generation < current)

theorem prepare_keeps_exact_recovery_proof (c d : Client) (accepted : prepare c = some d) :
    d.proof = c.proof ∧ d.pending = true ∧ d.payloadPresent = false := by
  unfold prepare at accepted
  split at accepted
  next ready => cases accepted; exact ⟨rfl, rfl, ready.2⟩
  next => contradiction

theorem payload_blocks_relinquishment (c : Client) (retained : c.payloadPresent = true) : prepare c = none := by
  simp [prepare, retained]

theorem interrupted_before_adoption_retains_proof (c d : Client) (p : Proof)
    (original : c.proof = some p) (accepted : prepare c = some d) : d.proof = some p :=
  (prepare_keeps_exact_recovery_proof c d accepted).1.trans original

theorem only_adoption_drops_pending_proof (ackValid : Bool) (c d : Client) (accepted : adopt ackValid c = some d) :
    ackValid = true ∧ c.pending = true ∧ d.proof = none ∧ d.pending = false := by
  unfold adopt at accepted
  split at accepted
  next pending => cases accepted; exact ⟨pending.1, pending.2, rfl, rfl⟩
  next => contradiction

theorem invalid_ack_cannot_drop_proof (c : Client) : adopt false c = none := by simp [adopt]

theorem old_signed_proof_retries_after_deletion (current : Nat) (p : Proof) (old : p.generation < current) :
    retryWithoutRow current true p = true := by simp [retryWithoutRow, old]

theorem missing_current_row_is_not_a_retry (p : Proof) : retryWithoutRow p.generation true p = false := by
  simp [retryWithoutRow]

theorem unauthenticated_proof_never_retries (current : Nat) (p : Proof) : retryWithoutRow current false p = false := rfl

end ConvergeAudit.RecoveryRelease
