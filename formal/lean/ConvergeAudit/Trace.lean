import Std

namespace ConvergeAudit

variable {State Command : Type}

/-- The deterministic kernel includes command rejection, clocks, RNG and receipts
in its explicit state/input. It must not consult host time or hidden randomness. -/
def run (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) : Nat → State
  | 0 => initial
  | n + 1 => step (run step initial inputs n) (inputs n)

/-- Only indices up to `n` matter. Cryptographic commitment and input completeness
are external obligations, not consequences of this predicate. -/
def ValidTrace (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n : Nat) : Prop :=
  trace 0 = initial ∧ ∀ i, i < n → trace (i + 1) = step (trace i) (inputs i)

def checkStep [DecidableEq State] (step : State → Command → State)
    (inputs : Nat → Command) (trace : Nat → State) (i : Nat) : Bool :=
  decide (trace (i + 1) = step (trace i) (inputs i))

theorem check_step_correct [DecidableEq State] (step : State → Command → State)
    (inputs : Nat → Command) (trace : Nat → State) (i : Nat) :
    checkStep step inputs trace i = true ↔
      trace (i + 1) = step (trace i) (inputs i) := by
  simp [checkStep]

theorem run_valid (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (n : Nat) :
    ValidTrace step initial inputs (run step initial inputs) n := by
  exact ⟨rfl, fun _ _ => rfl⟩

theorem valid_trace_matches_run (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n : Nat)
    (h : ValidTrace step initial inputs trace n) :
    trace n = run step initial inputs n := by
  induction n with
  | zero => exact h.1
  | succ n ih =>
    have validPrefix : ValidTrace step initial inputs trace n :=
      ⟨h.1, fun i hi => h.2 i (by omega)⟩
    rw [h.2 n (by omega), run, ih validPrefix]

/-- A false output from a trusted starting state and the same fixed inputs has
at least one locally invalid transition. This also covers empty batches. -/
theorem wrong_output_has_bad_step (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n : Nat)
    (start : trace 0 = initial) (wrong : trace n ≠ run step initial inputs n) :
    ∃ i, i < n ∧ trace (i + 1) ≠ step (trace i) (inputs i) := by
  classical
  apply Classical.byContradiction
  intro absent
  apply wrong
  apply valid_trace_matches_run step initial inputs trace n
  refine ⟨start, ?_⟩
  intro i hi
  apply Classical.byContradiction
  intro bad
  exact absent ⟨i, hi, bad⟩

/-- Opening checks must authenticate the index as well as the value against the
fixed batch roots. The model supplies those checked equalities explicitly. -/
theorem authenticated_bad_step_refutes_trace
    (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n i : Nat)
    (before after : State) (command : Command)
    (inside : i < n) (openBefore : before = trace i)
    (openAfter : after = trace (i + 1)) (openInput : command = inputs i)
    (bad : after ≠ step before command) :
    ¬ ValidTrace step initial inputs trace n := by
  intro valid
  apply bad
  rw [openBefore, openAfter, openInput]
  exact valid.2 i inside

end ConvergeAudit
