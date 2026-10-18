import Std
namespace ConvergeAudit.Generations

def jsMax : Nat := 9007199254740991
structure Start where
  generation : Nat
  head : Nat
  deriving DecidableEq, Repr
structure Record where
  start : Start
  ticket : Nat
  receipt : Option Nat
  terminal : Bool
  retired : Bool
  held : Bool
  secret : Option Nat
  deriving DecidableEq, Repr
structure Source where
  start : Start
  ticket : Nat
  receipt : Option Nat
  terminal : Bool
  retired : Bool
  held : Bool
  deriving DecidableEq, Repr
def source (r : Record) : Source := ⟨r.start, r.ticket, r.receipt, r.terminal, r.retired, r.held⟩
def stripSecret (r : Record) : Record := { r with secret := none }
structure ArchiveEntry where
  start : Start
  live : Bool
  deriving DecidableEq, Repr
structure State where
  generation : Nat
  admissions : List Start
  hot : List Record
  cold : List Record
  archiveFloor : Nat
  archives : List ArchiveEntry
  lastClosed : Option Nat
  deriving DecidableEq, Repr

/-- Fixed scope and owner are implicit. Runtime signatures authenticate ticket
generation; host durable metadata authenticates the current generation. The
closed-state booleans compose existing finality/case/archive obligations. -/
def Closed (s : State) : Prop :=
  s.admissions.length = s.hot.length ∧
  (∀ r ∈ s.hot, r.start.generation = s.generation ∧ r.terminal = true ∧ r.retired = true ∧ r.held = false) ∧
  s.archiveFloor = s.generation ∧ (∀ a ∈ s.archives, a.live = false)
instance (s : State) : Decidable (Closed s) := by unfold Closed; infer_instance
def Bounded (s : State) : Prop := s.admissions.length ≤ 1024 ∧ s.hot.length ≤ 1024 ∧ s.archives.length ≤ 128
def Sources (s : State) : List Source := s.cold.map source ++ s.hot.map source
def allocate (a : Start) (s : State) : Option State :=
  if a.generation = s.generation ∧ a ∉ s.admissions ∧ s.admissions.length < 1024 then
    some { s with admissions := s.admissions ++ [a] } else none
def issue (a : Start) (ticket secret : Nat) (s : State) : Option State :=
  if a.generation = s.generation ∧ a ∈ s.admissions ∧ s.hot.length < 1024 ∧
      (∀ r ∈ s.hot, r.start ≠ a) ∧ (∀ r ∈ s.cold ++ s.hot, r.ticket ≠ ticket) then
    some { s with hot := s.hot ++ [⟨a, ticket, none, false, false, false, some secret⟩] } else none
def registerArchive (a : ArchiveEntry) (s : State) : Option State :=
  if s.archiveFloor ≤ a.start.generation ∧ a.start.generation = s.generation ∧ s.archives.length < 128 then
    some { s with archives := s.archives ++ [a] } else none
def rotated (expected : Nat) (s : State) : State :=
  { s with
    generation := s.generation + 1
    admissions := []
    hot := []
    cold := s.cold ++ s.hot.map stripSecret
    archiveFloor := s.generation + 1
    archives := []
    lastClosed := some expected }
def roll (expected : Nat) (s : State) : Option State :=
  if expected = s.generation ∧ s.generation < jsMax ∧ Closed s then
    some (rotated expected s)
  else if s.generation = expected + 1 ∧ s.lastClosed = some expected then some s else none

theorem roll_is_fresh_or_exact_retry (expected : Nat) (s t : State) (accepted : roll expected s = some t) :
    (expected = s.generation ∧ s.generation < jsMax ∧ Closed s ∧
      t = rotated expected s) ∨
    (s.generation = expected + 1 ∧ s.lastClosed = some expected ∧ t = s) := by
  unfold roll at accepted
  split at accepted
  next allowed => cases accepted; exact Or.inl ⟨allowed.1, allowed.2.1, allowed.2.2, rfl⟩
  next =>
    split at accepted
    next retry => cases accepted; exact Or.inr ⟨retry.1, retry.2, rfl⟩
    next => contradiction

theorem fresh_roll_requires_all_retirement (expected : Nat) (s t : State) (same : expected = s.generation)
    (accepted : roll expected s = some t) : Closed s := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => exact fresh.2.2.1
  | inr retry => omega

theorem live_archive_blocks_fresh_roll (s : State) (a : ArchiveEntry) (member : a ∈ s.archives) (live : a.live = true) :
    roll s.generation s = none := by
  have denied : ¬ Closed s := by intro closed; have := closed.2.2.2 a member; simp_all
  simp [roll, denied]

theorem unused_admission_blocks_fresh_roll (s : State) (unused : s.hot.length < s.admissions.length) : roll s.generation s = none := by
  have denied : ¬ Closed s := by intro closed; have := closed.1; omega
  simp [roll, denied]

theorem held_record_blocks_fresh_roll (s : State) (r : Record) (member : r ∈ s.hot) (held : r.held = true) : roll s.generation s = none := by
  have denied : ¬ Closed s := by intro closed; have := (closed.2.1 r member).2.2.2; simp_all
  simp [roll, denied]

/-- The runtime checks the live case-service aggregate as well as the cached
row flag in the same transaction. No single-case clearance can override it. -/
def attachHolds (held : Nat → Bool) (s : State) : State :=
  { s with hot := s.hot.map (fun r => { r with held := r.held || held r.ticket }) }

theorem live_case_blocks_generation (held : Nat → Bool) (s : State) (r : Record)
    (member : r ∈ s.hot) (live : held r.ticket = true) : roll s.generation (attachHolds held s) = none := by
  apply held_record_blocks_fresh_roll (attachHolds held s) { r with held := r.held || held r.ticket }
  · exact List.mem_map_of_mem member
  · simp [live]

theorem roll_generation_is_monotone (expected : Nat) (s t : State) (accepted : roll expected s = some t) : s.generation ≤ t.generation := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => rw [fresh.2.2.2]; simp [rotated]
  | inr retry => rw [retry.2.2]; exact Nat.le_refl _

theorem exact_retry_preserves_current_work (expected : Nat) (s : State)
    (next : s.generation = expected + 1) (last : s.lastClosed = some expected) : roll expected s = some s := by
  simp [roll, next, last]

theorem fresh_roll_advances (expected : Nat) (s t : State) (same : expected = s.generation)
    (accepted : roll expected s = some t) : t.generation = s.generation + 1 ∧ t.archiveFloor = t.generation := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => rw [fresh.2.2.2]; exact ⟨rfl, rfl⟩
  | inr retry => omega

theorem fresh_roll_preserves_safe_integer (expected : Nat) (s t : State) (same : expected = s.generation)
    (accepted : roll expected s = some t) : t.generation ≤ jsMax := by
  have next := (fresh_roll_advances expected s t same accepted).1
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => omega
  | inr retry => omega

theorem fresh_roll_reclaims_only_hot_slots (expected : Nat) (s t : State) (same : expected = s.generation)
    (accepted : roll expected s = some t) : t.hot = [] ∧ t.admissions = [] ∧ t.archives = [] := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => rw [fresh.2.2.2]; exact ⟨rfl, rfl, rfl⟩
  | inr retry => omega

theorem secret_stripping_preserves_source (r : Record) : source (stripSecret r) = source r := rfl

theorem roll_preserves_all_provenance (expected : Nat) (s t : State) (accepted : roll expected s = some t) : Sources t = Sources s := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => rw [fresh.2.2.2]; simp [Sources, rotated, List.map_map, Function.comp_def, secret_stripping_preserves_source]
  | inr retry => rw [retry.2.2]

theorem cold_secrets_stay_erased (expected : Nat) (s t : State) (erased : ∀ r ∈ s.cold, r.secret = none)
    (accepted : roll expected s = some t) : ∀ r ∈ t.cold, r.secret = none := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh =>
    rw [fresh.2.2.2]
    intro r member
    cases List.mem_append.mp member with
    | inl old => exact erased r old
    | inr moved => obtain ⟨original, _, equal⟩ := List.mem_map.mp moved; rw [← equal]; rfl
  | inr retry => rw [retry.2.2]; exact erased

theorem old_generation_cannot_issue (a : Start) (ticket secret : Nat) (s : State)
    (old : a.generation < s.generation) : issue a ticket secret s = none := by
  have different : a.generation ≠ s.generation := by omega
  simp [issue, different]

theorem old_generation_cannot_allocate (a : Start) (s : State) (old : a.generation < s.generation) : allocate a s = none := by
  have different : a.generation ≠ s.generation := by omega
  simp [allocate, different]

theorem old_archive_cannot_reregister (a : ArchiveEntry) (s : State) (old : a.start.generation < s.archiveFloor) : registerArchive a s = none := by
  have different : ¬ s.archiveFloor ≤ a.start.generation := by omega
  simp [registerArchive, different]

theorem fresh_roll_blocks_old_start_forever_at_boundary (expected : Nat) (s t : State) (a : Start) (ticket secret : Nat)
    (same : expected = s.generation) (old : a.generation ≤ s.generation) (accepted : roll expected s = some t) : issue a ticket secret t = none := by
  have next := (fresh_roll_advances expected s t same accepted).1
  exact old_generation_cannot_issue a ticket secret t (by omega)

theorem issued_start_cannot_be_issued_again (a : Start) (ticket secret laterTicket laterSecret : Nat) (s t : State)
    (accepted : issue a ticket secret s = some t) : issue a laterTicket laterSecret t = none := by
  unfold issue at accepted
  split at accepted
  next =>
    cases accepted
    have used : ¬ ∀ r ∈ s.hot ++ [⟨a, ticket, none, false, false, false, some secret⟩], r.start ≠ a := by
      intro unused
      exact unused ⟨a, ticket, none, false, false, false, some secret⟩ (by simp) rfl
    simp only [issue]
    split
    next allowed => exact False.elim (used allowed.2.2.2.1)
    next => rfl
  next => contradiction

theorem allocate_preserves_bound (a : Start) (s t : State) (bounded : Bounded s) (accepted : allocate a s = some t) : Bounded t := by
  unfold allocate at accepted
  split at accepted
  next allowed => cases accepted; simp only [Bounded, List.length_append, List.length_singleton]; exact ⟨by omega, bounded.2⟩
  next => contradiction

theorem issue_preserves_bound (a : Start) (ticket secret : Nat) (s t : State) (bounded : Bounded s)
    (accepted : issue a ticket secret s = some t) : Bounded t := by
  unfold issue at accepted
  split at accepted
  next allowed => cases accepted; simp only [Bounded, List.length_append, List.length_singleton]; exact ⟨bounded.1, by omega, bounded.2.2⟩
  next => contradiction

theorem archive_preserves_bound (a : ArchiveEntry) (s t : State) (bounded : Bounded s) (accepted : registerArchive a s = some t) : Bounded t := by
  unfold registerArchive at accepted
  split at accepted
  next allowed => cases accepted; simp only [Bounded, List.length_append, List.length_singleton]; exact ⟨bounded.1, bounded.2.1, by omega⟩
  next => contradiction

theorem roll_preserves_bound (expected : Nat) (s t : State) (bounded : Bounded s) (accepted : roll expected s = some t) : Bounded t := by
  cases roll_is_fresh_or_exact_retry expected s t accepted with
  | inl fresh => rw [fresh.2.2.2]; simp [Bounded, rotated]
  | inr retry => rw [retry.2.2]; exact bounded

/-- Ordinary gameplay/custody operations preserve the epoch. This relation is
only used for the anti-replay theorem; it makes no source-preservation claim
for arbitrary ordinary operations. Roll source conservation is proved above. -/
inductive Follows : State → State → Prop where
  | refl (s) : Follows s s
  | ordinary {s m t} (history : Follows s m) (same : t.generation = m.generation) : Follows s t
  | rollover {s m t} (history : Follows s m) (expected) (accepted : roll expected m = some t) : Follows s t

theorem history_generation_is_monotone (s t : State) (history : Follows s t) : s.generation ≤ t.generation := by
  induction history with
  | refl => exact Nat.le_refl _
  | ordinary _ same ih => omega
  | rollover _ expected accepted ih => exact Nat.le_trans ih (roll_generation_is_monotone expected _ _ accepted)

theorem retired_start_is_rejected_in_every_future_generation (a : Start) (ticket secret : Nat) (s t : State)
    (old : a.generation < s.generation) (history : Follows s t) : issue a ticket secret t = none := by
  have monotone := history_generation_is_monotone s t history
  exact old_generation_cannot_issue a ticket secret t (by omega)

theorem retired_archive_is_rejected_in_every_future_generation (a : ArchiveEntry) (s t : State)
    (old : a.start.generation < s.generation) (history : Follows s t) : registerArchive a t = none := by
  have monotone := history_generation_is_monotone s t history
  have different : a.start.generation ≠ t.generation := by omega
  simp [registerArchive, different]

def MarketEligible (p : Source) : Prop := p.receipt.isSome = true ∧ p.held = false
theorem roll_preserves_source_and_market_eligibility (expected : Nat) (s t : State) (accepted : roll expected s = some t) (p : Source) :
    (p ∈ Sources t ∧ MarketEligible p) ↔ (p ∈ Sources s ∧ MarketEligible p) := by
  rw [roll_preserves_all_provenance expected s t accepted]

end ConvergeAudit.Generations
