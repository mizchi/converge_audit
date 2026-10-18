import ConvergeAudit.Chronology

namespace ConvergeAudit.Encounter

open Chronology

variable {Root Seed Reward Start Ticket : Type}

/-- Model of a single authoritative row. Root denotes an AUTHENTICATED log;
decoding, hash collision resistance, signatures and durable CAS are refinement
obligations of the host. `replay` below is actual deterministic execution, not
an unchecked `replayVerified` flag. This does not prove the game's own rules. -/
structure Record (Root Seed Reward : Type) where
  slot : Slot Root Seed
  reward : Option Reward := none
  retentionUntil : Nat
  held : Bool := false
  retired : Bool := false
  deriving DecidableEq, Repr

/-- One mint transition; an API retry reads the stored reward without minting. -/
def finish [DecidableEq Root] (replay : Root → Seed → Reward) (root : Root)
    (record : Record Root Seed Reward) : Option (Record Root Seed Reward) :=
  match record.slot with
  | .revealed pinned received opened seed =>
      if root = pinned then
        some { record with
          slot := .consumed root received opened seed
          reward := some (replay root seed) }
      else none
  | _ => none

def setHold (held : Bool) (record : Record Root Seed Reward) :
    Option (Record Root Seed Reward) :=
  if record.retired then none else some { record with held }

def marketRead (record : Record Root Seed Reward) : Option Reward :=
  if record.held then none else
    match record.slot with
    | .consumed _ _ _ _ => record.reward
    | _ => none

def RetireAllowed (now : Nat) (record : Record Root Seed Reward) : Prop :=
  record.reward.isSome = true ∧ record.retentionUntil ≤ now ∧ record.held = false

instance (now : Nat) (record : Record Root Seed Reward) : Decidable (RetireAllowed now record) := by
  unfold RetireAllowed
  infer_instance

/-- Retirement closes the case window before a signed deletion permit leaves
the authority. Late holds must not invalidate an already-issued deletion right. -/
def retire (now : Nat) (record : Record Root Seed Reward) :
    Option (Record Root Seed Reward) :=
  if RetireAllowed now record then some { record with retired := true } else none

theorem finish_sound [DecidableEq Root] (replay : Root → Seed → Reward)
    (root : Root) (before after : Record Root Seed Reward)
    (accepted : finish replay root before = some after) :
    ∃ received opened seed,
      before.slot = .revealed root received opened seed ∧
      after.slot = .consumed root received opened seed ∧
      after.reward = some (replay root seed) := by
  cases slotEq : before.slot with
  | revealed pinned received opened seed =>
      by_cases same : root = pinned
      · subst pinned
        simp only [finish, slotEq, ↓reduceIte] at accepted
        cases accepted
        exact ⟨received, opened, seed, rfl, rfl, rfl⟩
      · simp [finish, slotEq, same] at accepted
  | _ => simp [finish, slotEq] at accepted

theorem finalized_reward_uses_scheduled_seed [DecidableEq Root]
    (schedule : Schedule Seed) (replay : Root → Seed → Reward) (root : Root)
    (before after : Record Root Seed Reward) (value : Reward)
    (timed : WellTimed schedule before.slot)
    (accepted : finish replay root before = some after)
    (stored : after.reward = some value) : value = replay root schedule.seed := by
  obtain ⟨received, opened, seed, revealEq, _, rewardEq⟩ := finish_sound replay root before after accepted
  have timing : received < schedule.releaseAt ∧ schedule.releaseAt ≤ opened ∧ seed = schedule.seed := by
    simpa [revealEq, WellTimed] using timed
  have same : value = replay root seed := Option.some.inj (stored.symm.trans rewardEq)
  simpa [timing.2.2] using same

theorem finish_after_commit [DecidableEq Root] (schedule : Schedule Seed)
    (replay : Root → Seed → Reward) (root : Root) (before after : Record Root Seed Reward)
    (timed : WellTimed schedule before.slot)
    (accepted : finish replay root before = some after) :
    ∃ received opened seed, received < opened ∧ after.slot = .consumed root received opened seed := by
  obtain ⟨received, opened, seed, revealEq, consumedEq, _⟩ := finish_sound replay root before after accepted
  exact ⟨received, opened, seed,
    reveal_after_commit schedule root received opened seed (revealEq ▸ timed), consumedEq⟩

theorem held_reward_cannot_enter_market (record : Record Root Seed Reward)
    (held : record.held = true) : marketRead record = none := by
  simp [marketRead, held]

theorem admitted_market_reward_uses_scheduled_seed [DecidableEq Root]
    (schedule : Schedule Seed) (replay : Root → Seed → Reward) (root : Root)
    (before after : Record Root Seed Reward) (value : Reward)
    (timed : WellTimed schedule before.slot)
    (accepted : finish replay root before = some after)
    (admitted : marketRead after = some value) : value = replay root schedule.seed := by
  obtain ⟨_, _, _, _, consumedEq, _⟩ := finish_sound replay root before after accepted
  by_cases held : after.held = true
  · simp [marketRead, held] at admitted
  · have stored : after.reward = some value := by
      simpa [marketRead, held, consumedEq] using admitted
    exact finalized_reward_uses_scheduled_seed schedule replay root before after value timed accepted stored

theorem finish_cannot_repeat [DecidableEq Root] (replay : Root → Seed → Reward)
    (root other : Root) (before after : Record Root Seed Reward)
    (accepted : finish replay root before = some after) : finish replay other after = none := by
  obtain ⟨_, _, _, _, consumedEq, _⟩ := finish_sound replay root before after accepted
  simp [finish, consumedEq]

theorem retire_iff (now : Nat) (before after : Record Root Seed Reward) :
    retire now before = some after ↔
      RetireAllowed now before ∧ after = { before with retired := true } := by
  by_cases allowed : RetireAllowed now before <;> simp [retire, allowed, eq_comm]

theorem retirement_requires_finality_deadline_and_no_hold (now : Nat)
    (before after : Record Root Seed Reward) (accepted : retire now before = some after) :
    before.reward.isSome = true ∧ before.retentionUntil ≤ now ∧ before.held = false :=
  ((retire_iff now before after).mp accepted).1

theorem retirement_blocks_new_holds (now : Nat) (held : Bool)
    (before after : Record Root Seed Reward) (accepted : retire now before = some after) :
    setHold held after = none := by
  obtain ⟨_, rfl⟩ := (retire_iff now before after).mp accepted
  rfl

theorem retirement_keeps_certificate (now : Nat) (before after : Record Root Seed Reward)
    (accepted : retire now before = some after) :
    after.slot = before.slot ∧ after.reward = before.reward := by
  obtain ⟨_, rfl⟩ := (retire_iff now before after).mp accepted
  exact ⟨rfl, rfl⟩

theorem hold_keeps_certificate (held : Bool) (before after : Record Root Seed Reward)
    (accepted : setHold held before = some after) :
    after.slot = before.slot ∧ after.reward = before.reward := by
  by_cases closed : before.retired = true
  · simp [setHold, closed] at accepted
  · simp only [setHold, closed, Bool.false_eq_true, ↓reduceIte] at accepted
    cases accepted
    exact ⟨rfl, rfl⟩

/-- Start keys come from a trusted admission policy, not a caller nonce. Keeping
the occupied entry (or an equivalent spent nullifier) is essential after prune. -/
def reserve [DecidableEq Start] (ledger : Start → Option Ticket) (start : Start)
    (candidate : Ticket) : Start → Option Ticket :=
  match ledger start with
  | some _ => ledger
  | none => fun key => if key = start then some candidate else ledger key

theorem occupied_start_unchanged [DecidableEq Start] (ledger : Start → Option Ticket)
    (start : Start) (original candidate : Ticket) (occupied : ledger start = some original) :
    reserve ledger start candidate = ledger := by simp [reserve, occupied]

theorem fresh_start_reserved [DecidableEq Start] (ledger : Start → Option Ticket)
    (start : Start) (candidate : Ticket) (fresh : ledger start = none) :
    reserve ledger start candidate start = some candidate := by simp [reserve, fresh]

theorem reserve_preserves_spent_start [DecidableEq Start] (ledger : Start → Option Ticket)
    (spent proposed : Start) (original candidate : Ticket) (occupied : ledger spent = some original) :
    reserve ledger proposed candidate spent = some original := by
  by_cases same : spent = proposed
  · subst proposed
    simp [reserve, occupied]
  · cases proposal : ledger proposed <;> simp [reserve, proposal, same, occupied]

inductive IssuedHistory [DecidableEq Start] : (Start → Option Ticket) → (Start → Option Ticket) → Prop where
  | refl (ledger) : IssuedHistory ledger ledger
  | next {first middle} (history : IssuedHistory first middle) (start : Start) (ticket : Ticket) :
      IssuedHistory first (reserve middle start ticket)

theorem issuance_never_refunds_start [DecidableEq Start]
    (before after : Start → Option Ticket) (start : Start) (ticket : Ticket)
    (history : IssuedHistory before after) (occupied : before start = some ticket) :
    after start = some ticket := by
  induction history with
  | refl => exact occupied
  | next _ proposed candidate previous =>
      exact reserve_preserves_spent_start _ start proposed ticket candidate previous

end ConvergeAudit.Encounter
