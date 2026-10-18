import Std

namespace ConvergeAudit.Visibility

variable {World Observation Answer Public Secret Digest : Type}

/-- Exact prediction for every possible world. This is NOT a probability bound,
a computational-security definition, or a claim about human play. -/
def PerfectPredictor (observe : World → Observation) (target : World → Answer)
    (predict : Observation → Answer) : Prop :=
  ∀ world, predict (observe world) = target world

theorem public_computation_predictable (observe : World → Observation)
    (compute : Observation → Answer) :
    PerfectPredictor observe (fun world => compute (observe world)) compute := by
  intro world
  rfl

theorem equal_views_equal_decisions (observe : World → Observation)
    (decide : Observation → Answer) (first second : World)
    (same : observe first = observe second) :
    decide (observe first) = decide (observe second) := congrArg decide same

theorem indistinguishable_targets_no_perfect_predictor
    (observe : World → Observation) (target : World → Answer) (first second : World)
    (same : observe first = observe second) (different : target first ≠ target second) :
    ¬ ∃ predict, PerfectPredictor observe target predict := by
  rintro ⟨predict, perfect⟩
  exact different ((perfect first).symm.trans ((congrArg predict same).trans (perfect second)))

/-- Ideal information-flow contract: changing only the unreleased secret does
not change any observation. Real hiding commitments need a cryptographic model;
an ordinary public hash of a secret does not meet this exact equality contract. -/
def HidesSecret (view : Public → Secret → Observation) : Prop :=
  ∀ visible first second, view visible first = view visible second

theorem hidden_changes_do_not_change_decision (view : Public → Secret → Observation)
    (hidden : HidesSecret view) (decide : Observation → Answer)
    (visible : Public) (first second : Secret) :
    decide (view visible first) = decide (view visible second) :=
  congrArg decide (hidden visible first second)

theorem hidden_target_no_perfect_predictor (view : Public → Secret → Observation)
    (hidden : HidesSecret view) (target : Secret → Answer) (visible : Public)
    (first second : Secret) (different : target first ≠ target second) :
    ¬ ∃ predict, PerfectPredictor (view visible) target predict :=
  indistinguishable_targets_no_perfect_predictor (view visible) target first second
    (hidden visible first second) different

/-- Enumerating two possible deterministic commitments is already enough to
decode a low-entropy secret. This does not attack collision resistance. -/
theorem two_value_commitment_decodable [DecidableEq Digest] (commit : Bool → Digest)
    (different : commit false ≠ commit true) :
    PerfectPredictor commit id (fun value => decide (value = commit true)) := by
  intro value
  cases value <;> simp [different]

end ConvergeAudit.Visibility
