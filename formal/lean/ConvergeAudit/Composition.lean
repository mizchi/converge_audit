import ConvergeAudit.Settlement

namespace ConvergeAudit

variable {State Command : Type}

theorem run_congr_inputs (step : State → Command → State) (initial : State)
    (first second : Nat → Command) (n : Nat)
    (same : ∀ i, i < n → first i = second i) :
    run step initial first n = run step initial second n := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp only [run]
    rw [same n (by omega), ih (fun i hi => same i (by omega))]

/-- Continuing from a replayed checkpoint is equivalent to replaying the whole
prefix and suffix with exactly the same commands and kernel. -/
theorem run_shift (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (cut n : Nat) :
    run step (run step initial inputs cut) (fun i => inputs (cut + i)) n =
      run step initial inputs (cut + n) := by
  induction n with
  | zero => simp [run]
  | succ n ih =>
    rw [Nat.add_succ]
    change step (run step (run step initial inputs cut) (fun i => inputs (cut + i)) n)
        (inputs (cut + n)) =
      step (run step initial inputs (cut + n)) (inputs (cut + n))
    exact congrArg (fun state => step state (inputs (cut + n))) ih

def concatInputs (first second : Nat → Command) (cut : Nat) : Nat → Command :=
  fun i => if i < cut then first i else second (i - cut)

theorem run_concat (step : State → Command → State) (initial : State)
    (first second : Nat → Command) (cut n : Nat) :
    run step initial (concatInputs first second cut) (cut + n) =
      run step (run step initial first cut) second n := by
  have initialMatch : run step initial (concatInputs first second cut) cut =
      run step initial first cut := by
    apply run_congr_inputs
    intro i hi
    simp [concatInputs, hi]
  have suffixMatch : (fun i => concatInputs first second cut (cut + i)) = second := by
    funext i
    have later : ¬ cut + i < cut := by omega
    simp [concatInputs, later]
  rw [← run_shift step initial (concatInputs first second cut) cut n, initialMatch, suffixMatch]

/-- There is no trusted-state reset between checkpoints: the child's valid
initial state must equal the actual parent output, including at empty boundaries. -/
theorem valid_checkpoints_compose (step : State → Command → State) (initial : State)
    (firstInputs : Nat → Command) (firstTrace : Nat → State) (firstLength : Nat)
    (secondInputs : Nat → Command) (secondTrace : Nat → State) (secondLength : Nat)
    (parent : ValidTrace step initial firstInputs firstTrace firstLength)
    (child : ValidTrace step (firstTrace firstLength) secondInputs secondTrace secondLength) :
    secondTrace secondLength =
      run step initial (concatInputs firstInputs secondInputs firstLength) (firstLength + secondLength) := by
  rw [run_concat]
  have parentOutput := valid_trace_matches_run step initial firstInputs firstTrace firstLength parent
  have childOutput := valid_trace_matches_run step (firstTrace firstLength)
    secondInputs secondTrace secondLength child
  rw [parentOutput] at childOutput
  exact childOutput

/-- An application proves this once for its kernel and chosen safety property.
It does not follow merely from a signature or from convergence. -/
def Preserves (step : State → Command → State) (invariant : State → Prop) : Prop :=
  ∀ state command, invariant state → invariant (step state command)

theorem run_preserves_invariant (step : State → Command → State) (invariant : State → Prop)
    (initial : State) (inputs : Nat → Command) (n : Nat)
    (preserves : Preserves step invariant) (initialSafe : invariant initial) :
    invariant (run step initial inputs n) := by
  induction n with
  | zero => exact initialSafe
  | succ n ih => exact preserves _ _ ih

theorem valid_trace_preserves_invariant (step : State → Command → State)
    (invariant : State → Prop) (initial : State) (inputs : Nat → Command)
    (trace : Nat → State) (n : Nat)
    (preserves : Preserves step invariant) (initialSafe : invariant initial)
    (valid : ValidTrace step initial inputs trace n) : invariant (trace n) := by
  rw [valid_trace_matches_run step initial inputs trace n valid]
  exact run_preserves_invariant step invariant initial inputs n preserves initialSafe

theorem finalized_invariant
    {step : State → Command → State} {initial : State} {inputs : Nat → Command}
    {trace : Nat → State} {n : Nat} {raised : Nat → Prop} {facts : FinalityFacts}
    (invariant : State → Prop) (preserves : Preserves step invariant)
    (initialSafe : invariant initial)
    (evidence : FinalityEvidence step initial inputs trace n raised facts)
    (accepted : mayFinalize facts = true) : invariant (trace n) :=
  valid_trace_preserves_invariant step invariant initial inputs trace n preserves initialSafe
    (finality_gate_sound evidence accepted)

end ConvergeAudit
