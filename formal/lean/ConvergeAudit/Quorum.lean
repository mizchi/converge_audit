import Std

namespace ConvergeAudit

/-- Distinct members of a fixed, authenticated roster, indexed in [0,n).
Transport packets, duplicate signatures and non-roster identities are not counted. -/
def countMembers (members : Nat → Bool) : Nat → Nat
  | 0 => 0
  | n + 1 => countMembers members n + if members n then 1 else 0

theorem count_members_le_roster (members : Nat → Bool) (n : Nat) :
    countMembers members n ≤ n := by
  induction n with
  | zero => simp [countMembers]
  | succ n ih =>
    cases member : members n <;> simp [countMembers, member] <;> omega

theorem count_members_mono (first second : Nat → Bool) (n : Nat)
    (included : ∀ i, i < n → first i = true → second i = true) :
    countMembers first n ≤ countMembers second n := by
  induction n with
  | zero => simp [countMembers]
  | succ n ih =>
    have lower := ih (fun i hi => included i (by omega))
    have last := included n (by omega)
    cases left : first n <;> cases right : second n <;>
      simp [countMembers, left, right] at * <;> omega

/-- Inclusion-exclusion lower bound on the intersection, without an assumed
intersection oracle. The proof counts actual roster slots. -/
theorem quorum_intersection_count (first second : Nat → Bool) (n : Nat) :
    countMembers first n + countMembers second n ≤
      n + countMembers (fun i => first i && second i) n := by
  induction n with
  | zero => simp [countMembers]
  | succ n ih =>
    cases left : first n <;> cases right : second n <;>
      simp [countMembers, left, right] at * <;> omega

theorem honest_quorum_intersection (first second faulty : Nat → Bool) (n q f : Nat)
    (firstQuorum : q ≤ countMembers first n) (secondQuorum : q ≤ countMembers second n)
    (faultBound : countMembers faulty n ≤ f) (threshold : n + f < 2 * q) :
    ∃ i, i < n ∧ first i = true ∧ second i = true ∧ faulty i = false := by
  classical
  have intersection := quorum_intersection_count first second n
  apply Classical.byContradiction
  intro absent
  have contained : ∀ i, i < n → (first i && second i) = true → faulty i = true := by
    intro i inside both
    have approvals : first i = true ∧ second i = true := by
      simpa only [Bool.and_eq_true] using both
    cases bad : faulty i with
    | false => exact False.elim (absent ⟨i, inside, approvals.1, approvals.2, bad⟩)
    | true => rfl
  have bounded := count_members_mono (fun i => first i && second i) faulty n contained
  omega

/-- Static-roster certificate agreement requires honest signers never to sign
two values for the SAME scope/epoch/parent/kernel statement. It proves neither
game validity nor liveness, key security or membership provisioning. -/
theorem quorum_decisions_unique {Decision : Type} (first second faulty : Nat → Bool)
    (n q f : Nat) (signed : Nat → Decision → Prop) (left right : Decision)
    (firstQuorum : q ≤ countMembers first n) (secondQuorum : q ≤ countMembers second n)
    (faultBound : countMembers faulty n ≤ f) (threshold : n + f < 2 * q)
    (authenticatedFirst : ∀ i, i < n → first i = true → signed i left)
    (authenticatedSecond : ∀ i, i < n → second i = true → signed i right)
    (honestNonEquivocation : ∀ i, i < n → faulty i = false →
      ∀ a b, signed i a → signed i b → a = b) : left = right := by
  obtain ⟨i, inside, leftVote, rightVote, honest⟩ :=
    honest_quorum_intersection first second faulty n q f firstQuorum secondQuorum faultBound threshold
  exact honestNonEquivocation i inside honest left right
    (authenticatedFirst i inside leftVote) (authenticatedSecond i inside rightVote)

end ConvergeAudit
