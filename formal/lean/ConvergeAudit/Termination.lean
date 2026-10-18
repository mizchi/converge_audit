import ConvergeAudit.Encounter

namespace ConvergeAudit.Termination
open Chronology Encounter
variable {Root Seed Reward Start : Type}

inductive Reason where
  | abandoned
  | expired
  deriving DecidableEq, Repr

structure Certificate where
  reason : Reason
  closedAt : Nat
  deriving DecidableEq, Repr

/-- The JS bridge validates safe-integer clocks, then sends this order bit
and deadline=1 to the Int guard. No absolute timestamp is narrowed. -/
def orderBit (now deadline : Nat) : Nat := if deadline ≤ now then 1 else 0

theorem normalized_clock_preserves_order (now deadline : Nat) :
    1 ≤ orderBit now deadline ↔ deadline ≤ now := by
  by_cases elapsed : deadline ≤ now <;> simp [orderBit, elapsed]

theorem normalized_clock_is_bounded (now deadline : Nat) : orderBit now deadline ≤ 1 := by
  unfold orderBit
  split <;> omega

/-- One authoritative entry. `start` is the already-occupied start resource;
none of these operations remove it from the admission ledger. Authentication,
signed certificate encoding, clocks and durable CAS remain host duties. -/
structure State (Root Seed Reward Start : Type) where
  game : Record Root Seed Reward
  start : Start
  termination : Option Certificate := none
  deriving DecidableEq, Repr

def isStopped : Slot Root Seed → Bool
  | .forfeited _ => true
  | _ => false

def Closed (s : State Root Seed Reward Start) : Prop :=
  s.game.reward.isNone = true ∧ isStopped s.game.slot = true ∧ s.termination.isSome = true
instance (s : State Root Seed Reward Start) : Decidable (Closed s) := by unfold Closed; infer_instance

def stop (now delay : Nat) (reason : Reason) (root : Option Root)
    (s : State Root Seed Reward Start) : State Root Seed Reward Start :=
  { s with
    game := { s.game with slot := .forfeited root, retentionUntil := now + delay }
    termination := some ⟨reason, now⟩ }

/-- Expiry applies only to an uncommitted slot after its commit deadline.
Committed/revealed slots require explicit owner abandonment. Retrying a closed
entry returns its original certificate and never moves its retention deadline.
Legacy forfeiture without a certificate starts a conservative retention window. -/
def close (now delay deadline : Nat) (reason : Reason) (s : State Root Seed Reward Start) :
    Option (State Root Seed Reward Start) :=
  if s.game.reward.isNone = true then
    match s.game.slot with
    | .consumed _ _ _ _ => none
    | .forfeited root =>
      if s.termination.isSome then some s else some (stop now delay .abandoned root s)
    | .fresh =>
      if reason = .abandoned ∨ deadline ≤ now then some (stop now delay reason none s) else none
    | .locked root _ | .revealed root _ _ _ =>
      if reason = .abandoned then some (stop now delay reason (some root) s) else none
  else none

def cleanup (now : Nat) (s : State Root Seed Reward Start) : Option (State Root Seed Reward Start) :=
  if Closed s ∧ s.game.retentionUntil ≤ now ∧ s.game.held = false then
    some { s with game.retired := true }
  else none

theorem closure_is_terminal (now delay deadline : Nat) (reason : Reason)
    (s t : State Root Seed Reward Start) (accepted : close now delay deadline reason s = some t) : Closed t := by
  cases slotEq : s.game.slot <;> cases certEq : s.termination <;>
    cases rewardEq : s.game.reward <;> cases reason <;>
    simp_all [close, stop, Closed, isStopped] <;>
    first
    | cases accepted; simp_all
    | obtain ⟨_, rfl⟩ := accepted; simp_all

theorem closed_cannot_finish [DecidableEq Root] (replay : Root → Seed → Reward) (root : Root)
    (s : State Root Seed Reward Start) (closed : Closed s) : finish replay root s.game = none := by
  obtain ⟨_, stopped, _⟩ := closed
  cases slotEq : s.game.slot <;> simp_all [isStopped, finish]

theorem closed_cannot_enter_market (s : State Root Seed Reward Start) (closed : Closed s) :
    marketRead s.game = none := by
  obtain ⟨_, stopped, _⟩ := closed
  cases slotEq : s.game.slot <;> simp_all [isStopped, marketRead]

theorem closed_blocks_protocol_events [DecidableEq Root] (schedule : Schedule Seed) (event : Event Root)
    (s : State Root Seed Reward Start) (closed : Closed s) : applyEvent schedule event s.game.slot = none := by
  obtain ⟨_, stopped, _⟩ := closed
  cases slotEq : s.game.slot <;> simp_all [isStopped]
  exact forfeited_terminal schedule event _

theorem closure_retry_unchanged (now delay deadline : Nat) (reason : Reason)
    (s : State Root Seed Reward Start) (closed : Closed s) : close now delay deadline reason s = some s := by
  obtain ⟨noReward, stopped, certificate⟩ := closed
  cases slotEq : s.game.slot <;> simp_all [isStopped, close]

theorem settled_cannot_close (now delay deadline : Nat) (reason : Reason)
    (s : State Root Seed Reward Start) (reward : s.game.reward.isSome = true) :
    close now delay deadline reason s = none := by
  cases eq : s.game.reward <;> simp_all [close]

theorem committed_cannot_expire (now delay deadline received : Nat) (root : Root)
    (s : State Root Seed Reward Start) (slot : s.game.slot = .locked root received) :
    close now delay deadline .expired s = none := by simp [close, slot]

theorem expiry_requires_deadline (now delay deadline : Nat) (s t : State Root Seed Reward Start)
    (fresh : s.game.slot = .fresh) (accepted : close now delay deadline .expired s = some t) : deadline ≤ now := by
  simp only [close, fresh] at accepted
  split at accepted
  next => split at accepted
          next allowed => simpa using allowed
          next => contradiction
  next => contradiction

theorem cleanup_iff (now : Nat) (s t : State Root Seed Reward Start) :
    cleanup now s = some t ↔ Closed s ∧ s.game.retentionUntil ≤ now ∧ s.game.held = false ∧
      t = { s with game.retired := true } := by
  by_cases allowed : Closed s ∧ s.game.retentionUntil ≤ now ∧ s.game.held = false
  · simp [cleanup, allowed, eq_comm]
  · simp only [cleanup, ite_eq_right allowed]
    constructor
    · intro impossible; cases impossible
    · intro impossible; exact False.elim (allowed ⟨impossible.1, impossible.2.1, impossible.2.2.1⟩)

theorem cleanup_blocks_new_holds (now : Nat) (held : Bool) (s t : State Root Seed Reward Start)
    (accepted : cleanup now s = some t) : setHold held t.game = none := by
  obtain ⟨_, _, _, rfl⟩ := (cleanup_iff now s t).mp accepted
  rfl

theorem cleanup_preserves_closure (now : Nat) (s t : State Root Seed Reward Start)
    (accepted : cleanup now s = some t) : Closed t := by
  obtain ⟨closed, _, _, rfl⟩ := (cleanup_iff now s t).mp accepted
  exact closed

theorem closure_keeps_start (now delay deadline : Nat) (reason : Reason)
    (s t : State Root Seed Reward Start) (accepted : close now delay deadline reason s = some t) : t.start = s.start := by
  cases slotEq : s.game.slot <;> simp only [close, slotEq] at accepted <;>
    repeat first | split at accepted | (cases accepted; rfl) | contradiction

theorem cleanup_keeps_start (now : Nat) (s t : State Root Seed Reward Start)
    (accepted : cleanup now s = some t) : t.start = s.start := by
  obtain ⟨_, _, _, rfl⟩ := (cleanup_iff now s t).mp accepted
  rfl

theorem closure_keeps_pin_and_hold (now delay deadline : Nat) (reason : Reason)
    (s t : State Root Seed Reward Start) (accepted : close now delay deadline reason s = some t) :
    pinned t.game.slot = pinned s.game.slot ∧ t.game.held = s.game.held := by
  cases slotEq : s.game.slot <;> simp only [close, slotEq] at accepted <;>
    repeat first | split at accepted | (cases accepted; simp_all [stop, pinned]) | contradiction

theorem cleanup_keeps_certificate (now : Nat) (s t : State Root Seed Reward Start)
    (accepted : cleanup now s = some t) : t.termination = s.termination ∧ t.game.slot = s.game.slot := by
  obtain ⟨_, _, _, rfl⟩ := (cleanup_iff now s t).mp accepted
  exact ⟨rfl, rfl⟩

/-- Successful operations after closure, including retry/hold/cleanup. Finishing
gameplay is deliberately in the relation: a proof must show it is impossible. -/
inductive Follows [DecidableEq Root] (replay : Root → Seed → Reward) :
    State Root Seed Reward Start → State Root Seed Reward Start → Prop where
  | refl (s) : Follows replay s s
  | close {s m t} (history : Follows replay s m) (now delay deadline reason)
      (accepted : close now delay deadline reason m = some t) : Follows replay s t
  | cleanup {s m t} (history : Follows replay s m) (now)
      (accepted : cleanup now m = some t) : Follows replay s t
  | hold {s m} {game} (history : Follows replay s m) (held)
      (accepted : setHold held m.game = some game) : Follows replay s { m with game }
  | finish {s m} {game} (history : Follows replay s m) (root)
      (accepted : finish replay root m.game = some game) : Follows replay s { m with game }

theorem closed_history_stays_closed [DecidableEq Root] (replay : Root → Seed → Reward)
    (s t : State Root Seed Reward Start) (history : Follows replay s t) (closed : Closed s) : Closed t := by
  induction history with
  | refl => exact closed
  | close _ now delay deadline reason accepted _ => exact closure_is_terminal now delay deadline reason _ _ accepted
  | cleanup _ now accepted _ => exact cleanup_preserves_closure now _ _ accepted
  | hold _ held accepted ih =>
    obtain ⟨slot, reward⟩ := hold_keeps_certificate held _ _ accepted
    simpa only [Closed, slot, reward] using ih
  | finish _ root accepted ih =>
    rw [closed_cannot_finish replay root _ ih] at accepted
    contradiction

theorem closed_history_never_mints [DecidableEq Root] (replay : Root → Seed → Reward)
    (s t : State Root Seed Reward Start) (history : Follows replay s t) (closed : Closed s) (root : Root) :
    finish replay root t.game = none ∧ marketRead t.game = none := by
  have later := closed_history_stays_closed replay s t history closed
  exact ⟨closed_cannot_finish replay root t later, closed_cannot_enter_market t later⟩

theorem history_never_refunds_start [DecidableEq Root] (replay : Root → Seed → Reward)
    (s t : State Root Seed Reward Start) (history : Follows replay s t) : t.start = s.start := by
  induction history with
  | refl => rfl
  | close _ now delay deadline reason accepted ih => exact (closure_keeps_start now delay deadline reason _ _ accepted).trans ih
  | cleanup _ now accepted ih => exact (cleanup_keeps_start now _ _ accepted).trans ih
  | hold _ _ _ ih => exact ih
  | finish _ _ _ ih => exact ih

end ConvergeAudit.Termination
