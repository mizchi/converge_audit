import ConvergeAudit.Encounter
namespace ConvergeAudit.Cases
variable {n : Nat}

structure Case where
  source : Nat
  resolution : Option Nat
  acknowledged : Bool
  deriving DecidableEq, Repr

/-- Finite lifetime slots; the host binds each slot to an immutable authenticated
case/target/source identity. Acknowledgement denotes the exact durable source
resolution, not merely an arbiter decision. Signatures and SQL refinement are
host obligations. Adding a case fences the SAME ticket revision transactionally. -/
structure Registry (capacity : Nat) where
  entries : Fin capacity → Option Case
  manualHold : Bool
  closed : Bool
  revision : Nat

def active : Option Case → Bool
  | none => false
  | some c => !c.acknowledged
def Clear (s : Registry n) : Prop := s.manualHold = false ∧ ∀ i, active (s.entries i) = false
instance (s : Registry n) : Decidable (Clear s) := by unfold Clear; infer_instance

def put (s : Registry n) (index : Fin n) (c : Case) : Registry n :=
  { s with entries := fun i => if i = index then some c else s.entries i }

def place (index : Fin n) (source : Nat) (s : Registry n) : Option (Registry n) :=
  if s.closed = false ∧ s.entries index = none then
    some { put s index ⟨source, none, false⟩ with revision := s.revision + 1 }
  else none

def decideCase (index : Fin n) (resolution : Nat) (s : Registry n) : Option (Registry n) :=
  match s.entries index with
  | none => none
  | some c => if c.resolution = none ∨ c.resolution = some resolution then
      some (put s index { c with resolution := some resolution }) else none

def acknowledge (index : Fin n) (source resolution : Nat) (authenticated : Bool) (s : Registry n) : Option (Registry n) :=
  match s.entries index with
  | none => none
  | some c => if authenticated = true ∧ c.source = source ∧ c.resolution = some resolution then
      some (put s index { c with acknowledged := true }) else none

/-- Finality and the retention deadline are checked separately. This model
isolates the additional all-cases-clear guard and the CAS fence. -/
def close (expectedRevision : Nat) (s : Registry n) : Option (Registry n) :=
  if s.revision = expectedRevision ∧ Clear s then some { s with closed := true, revision := s.revision + 1 } else none

theorem close_requires_every_case_clear (expected : Nat) (s t : Registry n)
    (accepted : close expected s = some t) : Clear s := by
  unfold close at accepted
  split at accepted
  next allowed => exact allowed.2
  next => contradiction

theorem live_case_blocks_close (expected : Nat) (s : Registry n) (index : Fin n)
    (live : active (s.entries index) = true) : close expected s = none := by
  have blocked : ¬ Clear s := by intro clear; have := clear.2 index; simp_all
  simp [close, blocked]

theorem clearing_manual_hold_does_not_clear_case (expected : Nat) (s : Registry n) (index : Fin n)
    (live : active (s.entries index) = true) : close expected { s with manualHold := false } = none :=
  live_case_blocks_close expected _ index live

theorem decision_preserves_every_hold (index : Fin n) (resolution : Nat) (s t : Registry n)
    (accepted : decideCase index resolution s = some t) : ∀ other, active (t.entries other) = active (s.entries other) := by
  unfold decideCase at accepted
  cases entry : s.entries index <;> simp only [entry] at accepted
  next => contradiction
  next c =>
    split at accepted
    next =>
      cases accepted
      intro other
      by_cases same : other = index
      · subst other; simp [put, active, entry]
      · simp [put, same]
    next => contradiction

theorem acknowledgement_requires_exact_source_and_decision (index : Fin n) (source resolution : Nat)
    (authenticated : Bool) (s t : Registry n) (accepted : acknowledge index source resolution authenticated s = some t) :
    authenticated = true ∧ ∃ c, s.entries index = some c ∧ c.source = source ∧ c.resolution = some resolution := by
  unfold acknowledge at accepted
  cases entry : s.entries index <;> simp only [entry] at accepted
  next => contradiction
  next c =>
    split at accepted
    next allowed => exact ⟨allowed.1, c, rfl, allowed.2⟩
    next => contradiction

theorem acknowledgement_keeps_other_case (index other : Fin n) (source resolution : Nat)
    (authenticated : Bool) (s t : Registry n) (different : other ≠ index)
    (accepted : acknowledge index source resolution authenticated s = some t) : t.entries other = s.entries other := by
  unfold acknowledge at accepted
  cases entry : s.entries index <;> simp only [entry] at accepted
  next => contradiction
  next c =>
    split at accepted
    next => cases accepted; simp [put, different]
    next => contradiction

theorem one_acknowledgement_cannot_release_another (expected : Nat) (index other : Fin n) (source resolution : Nat)
    (authenticated : Bool) (s t : Registry n) (different : other ≠ index)
    (accepted : acknowledge index source resolution authenticated s = some t)
    (live : active (s.entries other) = true) : close expected t = none := by
  have same := acknowledgement_keeps_other_case index other source resolution authenticated s t different accepted
  exact live_case_blocks_close expected t other (by simpa only [same] using live)

theorem placement_fences_revision (index : Fin n) (source : Nat) (s t : Registry n)
    (accepted : place index source s = some t) : t.revision = s.revision + 1 := by
  unfold place at accepted
  split at accepted
  next => cases accepted; rfl
  next => contradiction

theorem placement_refuses_old_closure_cas (index : Fin n) (source : Nat) (s t : Registry n)
    (accepted : place index source s = some t) : close s.revision t = none := by
  have revision := placement_fences_revision index source s t accepted
  have different : t.revision ≠ s.revision := by omega
  simp [close, different]

theorem closed_registry_refuses_new_case (index : Fin n) (source : Nat) (s : Registry n)
    (closed : s.closed = true) : place index source s = none := by simp [place, closed]

theorem closure_wins_before_new_case (expected : Nat) (index : Fin n) (source : Nat) (s t : Registry n)
    (accepted : close expected s = some t) : place index source t = none := by
  unfold close at accepted
  split at accepted
  next => cases accepted; exact closed_registry_refuses_new_case index source _ rfl
  next => contradiction

theorem occupied_case_cannot_be_replaced (index : Fin n) (source : Nat) (s : Registry n) (c : Case)
    (occupied : s.entries index = some c) : place index source s = none := by simp [place, occupied]

/-- Discharge the earlier single `held` adapter with the case registry while
preserving any pre-existing manual hold on the encounter record. -/
def attachCases {Root Seed Reward : Type} (s : Registry n) (game : Encounter.Record Root Seed Reward) :
    Encounter.Record Root Seed Reward := { game with held := game.held || decide (¬ Clear s) }

theorem case_blocks_existing_market {Root Seed Reward : Type} (s : Registry n)
    (game : Encounter.Record Root Seed Reward) (index : Fin n) (live : active (s.entries index) = true) :
    Encounter.marketRead (attachCases s game) = none := by
  have blocked : ¬ Clear s := by intro clear; have := clear.2 index; simp_all
  simp [attachCases, blocked, Encounter.marketRead]

theorem existing_retirement_requires_case_clear {Root Seed Reward : Type} (now : Nat) (s : Registry n)
    (game after : Encounter.Record Root Seed Reward)
    (accepted : Encounter.retire now (attachCases s game) = some after) : Clear s := by
  have noHold := (Encounter.retirement_requires_finality_deadline_and_no_hold now _ after accepted).2.2
  by_cases clear : Clear s
  · exact clear
  · simp [attachCases, clear] at noHold

end ConvergeAudit.Cases
