import Std

namespace ConvergeAudit

/-- Count of all-miss sample sequences for uniform independent sampling WITH
replacement from n fixed edges, of which bad are invalid. The probability is
this count divided by n^samples, assuming 0 < n and bad ≤ n. -/
def missNumerator (n bad : Nat) : Nat → Nat
  | 0 => 1
  | samples + 1 => (n - bad) * missNumerator n bad samples

theorem miss_numerator_eq_pow (n bad samples : Nat) :
    missNumerator n bad samples = (n - bad) ^ samples := by
  induction samples with
  | zero => rfl
  | succ samples ih => simp [missNumerator, ih, Nat.pow_succ, Nat.mul_comm]

/-- Any finite number of these samples can miss a single corrupt transition. -/
theorem single_fraud_can_be_missed (n samples : Nat) (many : 1 < n) :
    0 < missNumerator n 1 samples := by
  rw [miss_numerator_eq_pow]
  exact Nat.pow_pos (by omega)

end ConvergeAudit
