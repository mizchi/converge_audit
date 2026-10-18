import ConvergeAudit.Cases
namespace ConvergeAudit.Archive

/-- An exact ticket/root/receipt identity and minimum retention deadline. The
runtime additionally binds the queue, archive key, chunk digests and full bytes.
Accepted persistence means a complete, validated bundle is durably stored before
its signed promise becomes visible. Crypto and physical storage are host duties. -/
structure Manifest where
  ticket : Nat
  root : Nat
  receipt : Nat
  minRetainUntil : Nat
  deriving DecidableEq, Repr
structure State where
  target : Manifest
  localCopy : Bool
  remoteCopy : Option Manifest
  acknowledgement : Option Manifest
  closed : Bool
  held : Bool
  deriving DecidableEq, Repr

def Available (s : State) : Prop := s.closed = false → s.localCopy = true ∨ s.remoteCopy = some s.target
def CustodySound (s : State) : Prop :=
  s.acknowledgement = some s.target → s.closed = false → s.remoteCopy = some s.target
def Safe (s : State) : Prop := Available s ∧ CustodySound s
instance (s : State) : Decidable (Available s) := by unfold Available; infer_instance

def persist (candidate : Manifest) (s : State) : Option State :=
  if candidate = s.target then some { s with remoteCopy := some candidate } else none
def acknowledge (s : State) : Option State :=
  if s.remoteCopy = some s.target then some { s with acknowledgement := some s.target } else none
def handoff (s : State) : Option State :=
  if s.acknowledgement = some s.target then some { s with localCopy := false } else none
def closeEvidence (now : Nat) (s : State) : Option State :=
  if s.held = false ∧ s.target.minRetainUntil ≤ now then some { s with closed := true } else none
def setHold (held : Bool) (s : State) : Option State :=
  if s.closed then none else some { s with held }
def release (now : Nat) (s : State) : Option State :=
  if s.closed = true ∧ s.held = false ∧ s.target.minRetainUntil ≤ now then some { s with remoteCopy := none } else none

theorem acknowledgement_requires_durable_exact_bundle (s t : State) (accepted : acknowledge s = some t) :
    s.remoteCopy = some s.target := by
  unfold acknowledge at accepted
  split at accepted
  next stored => exact stored
  next => contradiction

theorem handoff_requires_acknowledgement (s t : State) (accepted : handoff s = some t) :
    s.acknowledgement = some s.target := by
  unfold handoff at accepted
  split at accepted
  next acknowledged => exact acknowledged
  next => contradiction

theorem handoff_does_not_close_cases (s t : State) (accepted : handoff s = some t) :
    t.closed = s.closed ∧ t.held = s.held ∧ t.remoteCopy = s.remoteCopy := by
  unfold handoff at accepted
  split at accepted
  next => cases accepted; exact ⟨rfl, rfl, rfl⟩
  next => contradiction

theorem release_requires_closure_deadline_and_no_hold (now : Nat) (s t : State)
    (accepted : release now s = some t) : s.closed = true ∧ s.held = false ∧ s.target.minRetainUntil ≤ now := by
  unfold release at accepted
  split at accepted
  next allowed => exact allowed
  next => contradiction

theorem elapsed_time_alone_cannot_release (now : Nat) (s : State) (unclosed : s.closed = false) : release now s = none := by
  simp [release, unclosed]

theorem closed_prevents_new_holds (s : State) (closed : s.closed = true) : setHold true s = none := by
  simp [setHold, closed]

theorem persist_preserves_safe (candidate : Manifest) (s t : State)
    (accepted : persist candidate s = some t) : Safe t := by
  unfold persist at accepted
  split at accepted
  next same => cases accepted; simp_all [Safe, Available, CustodySound]
  next => contradiction

theorem acknowledge_preserves_safe (s t : State) (_safe : Safe s) (accepted : acknowledge s = some t) : Safe t := by
  unfold acknowledge at accepted
  split at accepted
  next stored => cases accepted; simp_all [Safe, Available, CustodySound]
  next => contradiction

theorem handoff_preserves_safe (s t : State) (safe : Safe s) (accepted : handoff s = some t) : Safe t := by
  unfold handoff at accepted
  split at accepted
  next acknowledged =>
    cases accepted
    exact ⟨fun unclosed => Or.inr (safe.2 acknowledged unclosed), safe.2⟩
  next => contradiction

theorem close_preserves_safe (now : Nat) (s t : State) (accepted : closeEvidence now s = some t) : Safe t := by
  unfold closeEvidence at accepted
  split at accepted
  next => cases accepted; simp [Safe, Available, CustodySound]
  next => contradiction

theorem hold_preserves_safe (held : Bool) (s t : State) (safe : Safe s) (accepted : setHold held s = some t) : Safe t := by
  unfold setHold at accepted
  split at accepted
  next => contradiction
  next => cases accepted; exact safe

theorem release_preserves_safe (now : Nat) (s t : State) (accepted : release now s = some t) : Safe t := by
  unfold release at accepted
  split at accepted
  next allowed => cases accepted; simp [Safe, Available, CustodySound, allowed.1]
  next => contradiction

inductive Follows : State → State → Prop where
  | refl (s) : Follows s s
  | persist {s m t} (history : Follows s m) (candidate) (accepted : persist candidate m = some t) : Follows s t
  | acknowledge {s m t} (history : Follows s m) (accepted : acknowledge m = some t) : Follows s t
  | handoff {s m t} (history : Follows s m) (accepted : handoff m = some t) : Follows s t
  | close {s m t} (history : Follows s m) (now) (accepted : closeEvidence now m = some t) : Follows s t
  | hold {s m t} (history : Follows s m) (held) (accepted : setHold held m = some t) : Follows s t
  | release {s m t} (history : Follows s m) (now) (accepted : release now m = some t) : Follows s t

theorem history_preserves_safe (s t : State) (safe : Safe s) (history : Follows s t) : Safe t := by
  induction history with
  | refl => exact safe
  | persist _ candidate accepted _ => exact persist_preserves_safe candidate _ _ accepted
  | acknowledge _ accepted ih => exact acknowledge_preserves_safe _ _ ih accepted
  | handoff _ accepted ih => exact handoff_preserves_safe _ _ ih accepted
  | close _ now accepted _ => exact close_preserves_safe now _ _ accepted
  | hold _ held accepted ih => exact hold_preserves_safe held _ _ ih accepted
  | release _ now accepted _ => exact release_preserves_safe now _ _ accepted

theorem open_history_has_a_copy (s t : State) (safe : Safe s) (history : Follows s t) (unclosed : t.closed = false) :
    t.localCopy = true ∨ t.remoteCopy = some t.target := (history_preserves_safe s t safe history).1 unclosed

/-- Interpret the case-service aggregate at the archive release boundary too. -/
def withCases {n : Nat} (cases : Cases.Registry n) (s : State) : State :=
  { s with held := s.held || decide (¬ Cases.Clear cases) }

theorem live_case_blocks_remote_release {n : Nat} (cases : Cases.Registry n) (index : Fin n) (s : State) (now : Nat)
    (live : Cases.active (cases.entries index) = true) : release now (withCases cases s) = none := by
  have blocked : ¬ Cases.Clear cases := by intro clear; have := clear.2 index; simp_all
  simp [release, withCases, blocked]

end ConvergeAudit.Archive
