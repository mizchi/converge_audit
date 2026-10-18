import Std

namespace ConvergeAudit.Chronology

variable {Root Seed : Type}

/-- Trusted schedule for ONE authority-issued ticket/slot. The seed is secret
until release; secrecy, VRF security and clock authenticity are external duties.
This structure is not a client-visible message carrying an advance seed. -/
structure Schedule (Seed : Type) where
  releaseAt : Nat
  seed : Seed

/-- One durable authority ledger entry, never a player-controlled snapshot.
Issuance, admission quotas and cross-slot parent binding are separate contracts.
Consuming this entry does not by itself validate gameplay or mint a reward. -/
inductive Slot (Root Seed : Type) where
  | fresh
  | locked (root : Root) (committedAt : Nat)
  | revealed (root : Root) (committedAt releasedAt : Nat) (seed : Seed)
  | consumed (root : Root) (committedAt releasedAt : Nat) (seed : Seed)
  | forfeited (root : Option Root)
  deriving DecidableEq, Repr

/-- The time is supplied by the trusted receipt service. An identical retry
returns the original commitment; it does not acquire a later receipt time. -/
def commit [DecidableEq Root] (schedule : Schedule Seed) (now : Nat) (root : Root) :
    Slot Root Seed → Option (Slot Root Seed)
  | .fresh =>
      if now < schedule.releaseAt then some (.locked root now) else none
  | .locked previous received =>
      if root = previous then some (.locked previous received) else none
  | _ => none

/-- The caller cannot choose a new seed per attempt. The service releases the
fixed seed only after a valid commitment and the scheduled release time. -/
def release (schedule : Schedule Seed) (now : Nat) : Slot Root Seed → Option (Slot Root Seed)
  | .locked root received =>
      if received < schedule.releaseAt ∧ schedule.releaseAt ≤ now then
        some (.revealed root received now schedule.seed)
      else none
  | _ => none

/-- Consume this slot once for its pinned root. Actual reward admission must
also pass the independent gameplay-validity and ownership gates. -/
def redeem [DecidableEq Root] (root : Root) : Slot Root Seed → Option (Slot Root Seed)
  | .revealed previous received opened seed =>
      if root = previous then some (.consumed previous received opened seed) else none
  | _ => none

/-- Abandoning a ticket never restores its eligibility or unlocks another root. -/
def forfeit : Slot Root Seed → Option (Slot Root Seed)
  | .fresh => some (.forfeited none)
  | .locked root _ => some (.forfeited (some root))
  | .revealed root _ _ _ => some (.forfeited (some root))
  | _ => none

inductive Event (Root : Type) where
  | commit (time : Nat) (root : Root)
  | release (time : Nat)
  | redeem (root : Root)
  | forfeit

def applyEvent [DecidableEq Root] (schedule : Schedule Seed) (event : Event Root)
    (slot : Slot Root Seed) : Option (Slot Root Seed) :=
  match event with
  | .commit time root => commit schedule time root slot
  | .release time => release schedule time slot
  | .redeem root => redeem root slot
  | .forfeit => forfeit slot

def pinned : Slot Root Seed → Option Root
  | .fresh => none
  | .locked root _ | .revealed root _ _ _ | .consumed root _ _ _ => some root
  | .forfeited root => root

/-- No probability or adversarial-knowledge claim is hidden in this predicate. -/
def WellTimed (schedule : Schedule Seed) : Slot Root Seed → Prop
  | .locked _ received => received < schedule.releaseAt
  | .revealed _ received opened seed | .consumed _ received opened seed =>
      received < schedule.releaseAt ∧ schedule.releaseAt ≤ opened ∧ seed = schedule.seed
  | _ => True

/-- A linear history of successful atomic transitions for this SAME ledger entry.
Rejected requests do not mutate it. Separate copies are not a single history. -/
inductive Follows (schedule : Schedule Seed) [DecidableEq Root] :
    Slot Root Seed → Slot Root Seed → Prop where
  | refl (slot) : Follows schedule slot slot
  | next {first middle last} (history : Follows schedule first middle)
      (event : Event Root) (accepted : applyEvent schedule event middle = some last) :
      Follows schedule first last

theorem fresh_commit_iff [DecidableEq Root] (schedule : Schedule Seed)
    (now : Nat) (root : Root) (next : Slot Root Seed) :
    commit schedule now root .fresh = some next ↔
      now < schedule.releaseAt ∧ next = .locked root now := by
  by_cases before : now < schedule.releaseAt <;> simp [commit, before, eq_comm]

theorem retry_keeps_receipt [DecidableEq Root] (schedule : Schedule Seed)
    (now received : Nat) (root : Root) :
    commit schedule now root (.locked root received) = some (.locked root received) := by
  simp [commit]

theorem replacement_refused [DecidableEq Root] (schedule : Schedule Seed)
    (now received : Nat) (root other : Root) (different : other ≠ root) :
    commit schedule now other (.locked root received) = none := by
  simp [commit, different]

theorem apply_preserves_pin [DecidableEq Root] (schedule : Schedule Seed)
    (event : Event Root) {before after : Slot Root Seed} {root : Root}
    (pin : pinned before = some root)
    (accepted : applyEvent schedule event before = some after) :
    pinned after = some root := by
  cases before <;> cases event <;>
    simp_all [applyEvent, commit, release, redeem, forfeit, pinned] <;>
    first
    | obtain ⟨condition, rfl⟩ := accepted; simp_all
    | cases accepted; simp_all

theorem apply_preserves_time [DecidableEq Root] (schedule : Schedule Seed)
    (event : Event Root) {before after : Slot Root Seed}
    (timed : WellTimed schedule before)
    (accepted : applyEvent schedule event before = some after) :
    WellTimed schedule after := by
  cases before <;> cases event <;>
    simp_all [applyEvent, commit, release, redeem, forfeit, WellTimed] <;>
    first
    | obtain ⟨condition, rfl⟩ := accepted; simp_all
    | cases accepted; simp_all

theorem follows_preserves_pin [DecidableEq Root] (schedule : Schedule Seed)
    {before after : Slot Root Seed} {root : Root}
    (history : Follows schedule before after) (pin : pinned before = some root) :
    pinned after = some root := by
  induction history with
  | refl => exact pin
  | next _ event accepted previous =>
      exact apply_preserves_pin schedule event previous accepted

theorem follows_preserves_time [DecidableEq Root] (schedule : Schedule Seed)
    {before after : Slot Root Seed} (history : Follows schedule before after)
    (timed : WellTimed schedule before) : WellTimed schedule after := by
  induction history with
  | refl => exact timed
  | next _ event accepted previous =>
      exact apply_preserves_time schedule event previous accepted

theorem reachable_well_timed [DecidableEq Root] (schedule : Schedule Seed)
    {after : Slot Root Seed} (history : Follows schedule .fresh after) :
    WellTimed schedule after :=
  follows_preserves_time schedule history True.intro

theorem reveal_after_commit (schedule : Schedule Seed) (root : Root)
    (received opened : Nat) (seed : Seed)
    (timed : WellTimed schedule (.revealed root received opened seed)) :
    received < opened := by
  obtain ⟨before, after, _⟩ := timed
  omega

theorem revealed_seed_fixed (schedule : Schedule Seed) (root : Root)
    (received opened : Nat) (seed : Seed)
    (timed : WellTimed schedule (.revealed root received opened seed)) :
    seed = schedule.seed := timed.2.2

theorem consumed_terminal [DecidableEq Root] (schedule : Schedule Seed)
    (event : Event Root) (root : Root) (received opened : Nat) (seed : Seed) :
    applyEvent schedule event (.consumed root received opened seed) = none := by
  cases event <;> rfl

theorem forfeited_terminal [DecidableEq Root] (schedule : Schedule Seed)
    (event : Event Root) (root : Option Root) :
    applyEvent schedule event (.forfeited root) = none := by
  cases event <;> rfl

theorem follows_terminal [DecidableEq Root] (schedule : Schedule Seed)
    {before after : Slot Root Seed}
    (terminal : ∀ event, applyEvent schedule event before = none)
    (history : Follows schedule before after) : after = before := by
  induction history with
  | refl => rfl
  | next _ event accepted previous =>
      rw [previous, terminal event] at accepted
      contradiction

theorem redeem_success_consumes [DecidableEq Root] (root : Root)
    {before after : Slot Root Seed} (accepted : redeem root before = some after) :
    ∃ received opened seed, after = .consumed root received opened seed := by
  cases before <;> simp_all [redeem]
  exact ⟨_, _, _, accepted.2.symm⟩

theorem redeem_cannot_repeat [DecidableEq Root] (schedule : Schedule Seed)
    (root other : Root) {before after later : Slot Root Seed}
    (accepted : redeem root before = some after)
    (history : Follows schedule after later) : redeem other later = none := by
  obtain ⟨received, opened, seed, rfl⟩ := redeem_success_consumes root accepted
  have unchanged := follows_terminal schedule
    (fun event => consumed_terminal schedule event root received opened seed) history
  rw [unchanged]
  rfl

theorem cannot_change_committed_root [DecidableEq Root] (schedule : Schedule Seed)
    (root other : Root) (received : Nat) {later : Slot Root Seed}
    (history : Follows schedule (.locked root received) later)
    (laterPin : pinned later = some other) : root = other := by
  have original := follows_preserves_pin schedule history (root := root) rfl
  exact Option.some.inj (original.symm.trans laterPin)

end ConvergeAudit.Chronology
