import ConvergeAudit.Retention

namespace ConvergeAudit.PayloadPool

open Retention

/-- `before`/`after` concatenate all other queues, in any fixed order.
Both the selected queue and the global pool must admit the SAME chunk. The
host must make these checks and both counter updates one atomic transaction. -/
def scopedAdmit (globalBudget localBudget : Budget) (incoming : Chunk)
    (before selected after : List Chunk) : Option (List Chunk) :=
  if Admissible globalBudget incoming (before ++ selected ++ after) then
    admit localBudget incoming selected
  else none

theorem scoped_admission_iff (globalBudget localBudget : Budget) (incoming : Chunk)
    (before selected after next : List Chunk) :
    scopedAdmit globalBudget localBudget incoming before selected after = some next ↔
      Admissible globalBudget incoming (before ++ selected ++ after) ∧
      admit localBudget incoming selected = some next := by
  by_cases allowed : Admissible globalBudget incoming (before ++ selected ++ after)
  · rw [scopedAdmit, ite_eq_left allowed]
    exact ⟨fun accepted => ⟨allowed, accepted⟩, fun accepted => accepted.2⟩
  · rw [scopedAdmit, ite_eq_right allowed]
    constructor
    · intro impossible; cases impossible
    · intro accepted; exact False.elim (allowed accepted.1)

theorem scoped_admission_local_fits (globalBudget localBudget : Budget) (incoming : Chunk)
    (before selected after next : List Chunk)
    (accepted : scopedAdmit globalBudget localBudget incoming before selected after = some next) :
    Fits localBudget next :=
  admitted_queue_fits localBudget incoming selected next
    ((scoped_admission_iff globalBudget localBudget incoming before selected after next).mp accepted).2

theorem scoped_admission_global_fits (globalBudget localBudget : Budget) (incoming : Chunk)
    (before selected after next : List Chunk)
    (accepted : scopedAdmit globalBudget localBudget incoming before selected after = some next) :
    Fits globalBudget (before ++ next ++ after) := by
  obtain ⟨globalAllowed, localAccepted⟩ :=
    (scoped_admission_iff globalBudget localBudget incoming before selected after next).mp accepted
  obtain ⟨_, rfl⟩ := (admission_iff localBudget incoming selected next).mp localAccepted
  have appended := admitted_queue_fits globalBudget incoming (before ++ selected ++ after)
    ((before ++ selected ++ after) ++ [incoming])
    ((admission_iff globalBudget incoming _ _).mpr ⟨globalAllowed, rfl⟩)
  simp only [Fits, used_bytes_append, usedBytes, List.length_append, List.length_singleton] at *
  omega

theorem full_pool_blocks_every_queue (globalBudget localBudget : Budget) (incoming : Chunk)
    (before selected after : List Chunk)
    (full : globalBudget.maxItems ≤ (before ++ selected ++ after).length) :
    scopedAdmit globalBudget localBudget incoming before selected after = none := by
  have blocked : ¬ Admissible globalBudget incoming (before ++ selected ++ after) := by
    intro allowed
    have count := allowed.2.2.2.1
    omega
  simp only [scopedAdmit, blocked, ↓reduceIte]

theorem scoped_prune_preserves_global_fit (budget : Budget) (before selected after : List Chunk)
    (fits : Fits budget (before ++ selected ++ after)) :
    Fits budget (before ++ (prunePrefix selected).2 ++ after) := by
  have bytes := prune_does_not_increase_bytes selected
  have count := prune_does_not_increase_count selected
  simp only [Fits, used_bytes_append, List.length_append] at *
  omega

def registerScope (registered maximum : Nat) : Option Nat :=
  if registered < maximum then some (registered + 1) else none

theorem registration_bounds_metadata (registered maximum next : Nat)
    (accepted : registerScope registered maximum = some next) :
    next = registered + 1 ∧ next ≤ maximum := by
  by_cases allowed : registered < maximum
  · simp only [registerScope, allowed, ↓reduceIte, Option.some.injEq] at accepted
    omega
  · simp [registerScope, allowed] at accepted

theorem full_metadata_pool_refuses_registration (registered maximum : Nat)
    (full : maximum ≤ registered) : registerScope registered maximum = none := by
  simp [registerScope, Nat.not_lt.mpr full]

/-- A never-written empty reservation needs no evidence authorization. A scope
that once held data needs authenticated final closure, even after bytes = 0.
Authentication and binding of that evidence are external host obligations. -/
def releaseScope (registered : Nat) (chunks : List Chunk) (everWritten authorized : Bool) : Option Nat :=
  if 0 < registered ∧ chunks = [] ∧ (everWritten = false ∨ authorized = true) then
    some (registered - 1)
  else none

theorem released_scope_was_empty (registered next : Nat) (chunks : List Chunk)
    (everWritten authorized : Bool)
    (accepted : releaseScope registered chunks everWritten authorized = some next) :
    chunks = [] ∧ next + 1 = registered := by
  unfold releaseScope at accepted
  split at accepted
  next allowed => simp only [Option.some.injEq] at accepted; exact ⟨allowed.2.1, by omega⟩
  next => contradiction

theorem written_scope_release_requires_authorization (registered next : Nat) (chunks : List Chunk)
    (authorized : Bool) (accepted : releaseScope registered chunks true authorized = some next) :
    authorized = true := by
  unfold releaseScope at accepted
  split at accepted
  next allowed => simpa using allowed.2.2
  next => contradiction

theorem empty_scope_release_preserves_payload (registered next : Nat) (chunks before after : List Chunk)
    (everWritten authorized : Bool)
    (accepted : releaseScope registered chunks everWritten authorized = some next) :
    before ++ chunks ++ after = before ++ after := by
  have empty := (released_scope_was_empty registered next chunks everWritten authorized accepted).1
  simp [empty]

structure Stamp where
  incarnation : Nat
  revision : Nat
  deriving DecidableEq, Repr

def WellStamped (clock : Nat) (stamp : Stamp) : Prop :=
  0 < stamp.incarnation ∧ stamp.incarnation ≤ stamp.revision ∧ stamp.revision ≤ clock

instance (clock : Nat) (stamp : Stamp) : Decidable (WellStamped clock stamp) := by
  unfold WellStamped
  infer_instance

def freshStamp (clock : Nat) : Stamp := { incarnation := clock + 1, revision := clock + 1 }
def touchStamp (clock : Nat) (stamp : Stamp) : Stamp := { stamp with revision := clock + 1 }

theorem fresh_stamp_well_formed (clock : Nat) : WellStamped (clock + 1) (freshStamp clock) := by
  simp [WellStamped, freshStamp]

theorem touched_stamp_well_formed (clock : Nat) (stamp : Stamp)
    (valid : WellStamped clock stamp) : WellStamped (clock + 1) (touchStamp clock stamp) := by
  simp only [WellStamped, touchStamp] at *
  omega

theorem mutation_keeps_incarnation (clock : Nat) (stamp : Stamp) :
    (touchStamp clock stamp).incarnation = stamp.incarnation := rfl

theorem old_grant_cannot_match_recreated_scope (oldClock grantRevision clock : Nat) (stamp : Stamp)
    (oldGrant : grantRevision ≤ oldClock) (recreated : stamp.incarnation = oldClock + 1)
    (valid : WellStamped clock stamp) : grantRevision ≠ stamp.revision := by
  obtain ⟨_, ordered, _⟩ := valid
  omega

theorem unrelated_queue_writes_preserve_stamp (clock later : Nat) (stamp : Stamp)
    (valid : WellStamped clock stamp) (monotone : clock ≤ later) : WellStamped later stamp := by
  obtain ⟨positive, ordered, bounded⟩ := valid
  exact ⟨positive, ordered, Nat.le_trans bounded monotone⟩

end ConvergeAudit.PayloadPool
