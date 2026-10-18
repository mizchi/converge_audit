import Std
namespace ConvergeAudit.Recovery

/-- This is the controller's decision after validating an owner-bound ticket
and any terminal certificate. Authenticity of the remote observation, IndexedDB
contents, JS time and controller refinement are separate host obligations. -/
inductive RemotePhase where
  | issued | committed | revealed | settled | forfeited
  deriving DecidableEq, Repr
inductive UiPhase where
  | playing | ready | waiting | settled | terminated | interrupted
  deriving DecidableEq, Repr
structure Progress where
  firstSequence : Nat
  nextSequence : Nat
  retainedItems : Nat
  deriving DecidableEq, Repr
def Complete (p : Progress) : Prop :=
  p.firstSequence = 0 ∧ p.nextSequence = 2 ∧ p.retainedItems = 2
instance (p : Progress) : Decidable (Complete p) := by unfold Complete; infer_instance

/-- A volatile partial chunk is never reconstructed after reload. A full log
can retry its SAME commitment or wait for the pinned reveal. No recovery path
produces the `playing` capability. -/
def recover (remote : RemotePhase) (p : Progress) (now releaseAt : Nat) : UiPhase :=
  match remote with
  | .settled => .settled
  | .forfeited => .terminated
  | .issued => if Complete p ∧ now < releaseAt then .ready else .interrupted
  | .committed | .revealed => if Complete p then .waiting else .interrupted

def mayStep (phase : UiPhase) : Bool := phase == .playing

theorem recovery_never_resumes_play (remote : RemotePhase) (p : Progress) (now releaseAt : Nat) :
    recover remote p now releaseAt ≠ .playing := by
  cases remote <;> simp only [recover] <;> repeat first | split | decide

theorem recovered_session_cannot_step (remote : RemotePhase) (p : Progress) (now releaseAt : Nat) :
    mayStep (recover remote p now releaseAt) = false := by
  have stopped := recovery_never_resumes_play remote p now releaseAt
  simp [mayStep, beq_eq_false_iff_ne, stopped]

theorem ready_requires_complete_log_and_open_window (remote : RemotePhase) (p : Progress) (now releaseAt : Nat)
    (ready : recover remote p now releaseAt = .ready) : remote = .issued ∧ Complete p ∧ now < releaseAt := by
  cases remote <;> simp only [recover] at ready <;>
    repeat first | split at ready | contradiction | (constructor; rfl; assumption)

theorem waiting_requires_complete_log (remote : RemotePhase) (p : Progress) (now releaseAt : Nat)
    (waiting : recover remote p now releaseAt = .waiting) : Complete p := by
  cases remote <;> simp only [recover] at waiting <;>
    repeat first | split at waiting | contradiction | assumption

theorem incomplete_active_session_is_interrupted (remote : RemotePhase) (p : Progress) (now releaseAt : Nat)
    (partialLog : ¬ Complete p) (active : remote ≠ .settled ∧ remote ≠ .forfeited) :
    recover remote p now releaseAt = .interrupted := by
  cases remote <;> simp_all [recover]

theorem missed_commit_window_stays_interrupted (p : Progress) (now releaseAt : Nat) (missed : releaseAt ≤ now) :
    recover .issued p now releaseAt = .interrupted := by
  have late : ¬ now < releaseAt := by omega
  simp [recover, late]

theorem receipt_recovery_needs_no_raw_log (p : Progress) (now releaseAt : Nat) :
    recover .settled p now releaseAt = .settled := rfl

theorem stopped_ticket_recovery_never_reopens (p : Progress) (now releaseAt : Nat) :
    recover .forfeited p now releaseAt = .terminated := rfl

end ConvergeAudit.Recovery
