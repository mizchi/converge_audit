import ConvergeAudit.Visibility

open ConvergeAudit.Visibility

namespace Tests.Visibility

-- A deterministic future attack computed entirely from a public tick is predictable.
example : PerfectPredictor (fun tick : Nat => tick) (fun tick => tick % 3) (fun tick => tick % 3) :=
  public_computation_predictable (fun tick : Nat => tick) (fun tick => tick % 3)

-- Two possible secret futures with the SAME public view rule out a perfect predictor.
example : ¬ ∃ predict : Nat → Bool,
    PerfectPredictor (fun world : Nat × Bool => world.1) (fun world => world.2) predict := by
  exact indistinguishable_targets_no_perfect_predictor (fun world : Nat × Bool => world.1)
    (fun world => world.2) (0, false) (0, true) rfl (by decide)

-- Giving a client the secret plainly makes a perfect predictor possible.
example : PerfectPredictor (fun value : Bool => value) id id := by intro value; rfl

-- Hashing an enumerable secret without hidden randomization need not hide it.
def tinyCommit (value : Bool) : Nat := if value then 193 else 17
example : PerfectPredictor tinyCommit id (fun value => decide (value = tinyCommit true)) :=
  two_value_commitment_decodable tinyCommit (by decide)

example : HidesSecret (fun visible : Nat => fun _secret : Bool => visible) := by
  intro visible first second
  rfl

end Tests.Visibility
