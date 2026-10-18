import ConvergeAudit.Trace

namespace ConvergeAudit

variable {State Command : Type} [DecidableEq State]

/-- Binary dispute over exactly `2^depth` transitions. Inputs and trace roots
must already be fixed. A non-power-of-two batch needs deterministic no-op padding.
This finds an adjacent disagreement, which need not be the earliest one. -/
def locate (reference claimed : Nat → State) (lo : Nat) : Nat → Nat
  | 0 => lo
  | depth + 1 =>
    let mid := lo + 2 ^ depth
    if claimed mid = reference mid then locate reference claimed mid depth
    else locate reference claimed lo depth

/-- Each recursive call halves the interval; exactly `depth` midpoint queries
lead to an agreeing pre-state and a disagreeing post-state. -/
theorem locate_spec (reference claimed : Nat → State) (depth lo : Nat)
    (agree : claimed lo = reference lo)
    (disagree : claimed (lo + 2 ^ depth) ≠ reference (lo + 2 ^ depth)) :
    let i := locate reference claimed lo depth
    lo ≤ i ∧ i < lo + 2 ^ depth ∧
      claimed i = reference i ∧ claimed (i + 1) ≠ reference (i + 1) := by
  induction depth generalizing lo with
  | zero =>
    exact ⟨Nat.le_refl lo, Nat.lt_succ_self lo, agree, disagree⟩
  | succ depth ih =>
    simp only [locate]
    split
    next midAgree =>
      have endEq : lo + 2 ^ (depth + 1) = (lo + 2 ^ depth) + 2 ^ depth := by
        rw [Nat.pow_succ]
        omega
      rw [endEq] at disagree
      obtain ⟨lower, upper, pre, post⟩ := ih (lo + 2 ^ depth) midAgree disagree
      refine ⟨by omega, ?_, pre, post⟩
      rw [endEq]
      exact upper
    next midDisagree =>
      obtain ⟨lower, upper, pre, post⟩ := ih lo agree midDisagree
      refine ⟨lower, ?_, pre, post⟩
      rw [Nat.pow_succ]
      omega

/-- Central arbitration needs one kernel step once an honest reference has
localized a false output. Producing that reference still costs a replay. -/
theorem located_step_is_fraud (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (claimed : Nat → State) (depth : Nat)
    (start : claimed 0 = initial)
    (wrong : claimed (2 ^ depth) ≠ run step initial inputs (2 ^ depth)) :
    let i := locate (run step initial inputs) claimed 0 depth
    i < 2 ^ depth ∧ claimed (i + 1) ≠ step (claimed i) (inputs i) := by
  have ends : claimed (0 + 2 ^ depth) ≠ run step initial inputs (0 + 2 ^ depth) := by
    simpa using wrong
  obtain ⟨_, inside, pre, post⟩ := locate_spec (run step initial inputs) claimed depth 0 start ends
  refine ⟨by simpa using inside, ?_⟩
  intro h
  apply post
  rw [h, pre]
  rfl

end ConvergeAudit
