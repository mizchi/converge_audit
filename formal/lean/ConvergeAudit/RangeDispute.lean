import ConvergeAudit.Dispute

namespace ConvergeAudit

/-- The minimum binary depth covering a width. Zero and one require no queries. -/
def ceilLog2 (width : Nat) : Nat :=
  if width ≤ 1 then 0 else (width - 1).log2 + 1

theorem width_fits_ceil_log2 (width : Nat) : width ≤ 2 ^ ceilLog2 width := by
  unfold ceilLog2
  split
  next small => simpa using small
  next large =>
    have upper := Nat.lt_log2_self (n := width - 1)
    omega

theorem ceil_log2_minimal (width depth : Nat) :
    ceilLog2 width ≤ depth ↔ width ≤ 2 ^ depth := by
  unfold ceilLog2
  split
  next small =>
    have positive : 0 < 2 ^ depth := Nat.pow_pos (by decide)
    simp only [Nat.zero_le, true_iff]
    omega
  next large =>
    have nonzero : width - 1 ≠ 0 := by omega
    constructor
    · intro bound
      have logBound : (width - 1).log2 < depth := by omega
      have := (Nat.log2_lt nonzero).mp logBound
      omega
    · intro bound
      have below : width - 1 < 2 ^ depth := by omega
      have := (Nat.log2_lt nonzero).mpr below
      omega

structure DisputeResult where
  index : Nat
  queries : Nat
  deriving DecidableEq, Repr

variable {State Command : Type} [DecidableEq State]

/-- The fuel bounds the number of midpoint comparisons. The public wrapper
chooses sufficient fuel; the internal fallback at depth zero is not a verifier. -/
private def locateWithin (reference claimed : Nat → State) (lo width : Nat) : Nat → DisputeResult
  | 0 => ⟨lo, 0⟩
  | depth + 1 =>
    if width ≤ 1 then ⟨lo, 0⟩ else
      let half := width / 2
      let mid := lo + half
      let next := if claimed mid = reference mid then
        locateWithin reference claimed mid (width - half) depth
      else locateWithin reference claimed lo half depth
      ⟨next.index, next.queries + 1⟩

private theorem locate_within_spec (reference claimed : Nat → State) (depth lo width : Nat)
    (positive : 0 < width) (fits : width ≤ 2 ^ depth)
    (agree : claimed lo = reference lo)
    (disagree : claimed (lo + width) ≠ reference (lo + width)) :
    let result := locateWithin reference claimed lo width depth
    lo ≤ result.index ∧ result.index < lo + width ∧
      claimed result.index = reference result.index ∧
      claimed (result.index + 1) ≠ reference (result.index + 1) ∧
      result.queries ≤ depth := by
  induction depth generalizing lo width with
  | zero =>
    have one : width = 1 := by simpa using Nat.le_antisymm fits positive
    subst width
    exact ⟨Nat.le_refl lo, Nat.lt_succ_self lo, agree, disagree, Nat.le_refl 0⟩
  | succ depth ih =>
    simp only [locateWithin]
    split
    next small =>
      have one : width = 1 := by omega
      subst width
      exact ⟨Nat.le_refl lo, Nat.lt_succ_self lo, agree, disagree, Nat.zero_le _⟩
    next large =>
      rw [Nat.pow_succ] at fits
      have halfPositive : 0 < width / 2 := by omega
      have rightPositive : 0 < width - width / 2 := by omega
      have leftFits : width / 2 ≤ 2 ^ depth := by omega
      have rightFits : width - width / 2 ≤ 2 ^ depth := by omega
      split
      next midAgree =>
        dsimp only
        have endEq : lo + width = (lo + width / 2) + (width - width / 2) := by omega
        rw [endEq] at disagree
        obtain ⟨lower, upper, pre, post, queries⟩ :=
          ih (lo + width / 2) (width - width / 2) rightPositive rightFits midAgree disagree
        exact ⟨by omega, by omega, pre, post, by omega⟩
      next midDisagree =>
        dsimp only
        obtain ⟨lower, upper, pre, post, queries⟩ :=
          ih lo (width / 2) halfPositive leftFits agree midDisagree
        exact ⟨lower, by omega, pre, post, by omega⟩

/-- No padding inputs or states are invented. An empty interval has no edge and
returns `none`; a singleton interval needs no midpoint query. -/
def locateRange (reference claimed : Nat → State) (lo width : Nat) : Option DisputeResult :=
  if width = 0 then none else
    some (locateWithin reference claimed lo width (ceilLog2 width))

theorem locate_range_spec (reference claimed : Nat → State) (lo width : Nat)
    (positive : 0 < width) (agree : claimed lo = reference lo)
    (disagree : claimed (lo + width) ≠ reference (lo + width)) :
    ∃ result, locateRange reference claimed lo width = some result ∧
      lo ≤ result.index ∧ result.index < lo + width ∧
      claimed result.index = reference result.index ∧
      claimed (result.index + 1) ≠ reference (result.index + 1) ∧
      result.queries ≤ ceilLog2 width := by
  refine ⟨_, ?_, locate_within_spec reference claimed (ceilLog2 width) lo width positive
    (width_fits_ceil_log2 width) agree disagree⟩
  simp [locateRange, Nat.ne_of_gt positive]

theorem located_range_step_is_fraud (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (claimed : Nat → State) (n : Nat)
    (start : claimed 0 = initial) (wrong : claimed n ≠ run step initial inputs n) :
    ∃ result, locateRange (run step initial inputs) claimed 0 n = some result ∧
      result.index < n ∧ result.queries ≤ ceilLog2 n ∧
      claimed (result.index + 1) ≠ step (claimed result.index) (inputs result.index) := by
  have positive : 0 < n := by
    cases n with
    | zero => exact False.elim (wrong start)
    | succ n => omega
  obtain ⟨result, found, _, inside, pre, post, queries⟩ :=
    locate_range_spec (run step initial inputs) claimed 0 n positive start (by simpa using wrong)
  refine ⟨result, found, by simpa using inside, queries, ?_⟩
  intro valid
  apply post
  rw [valid, pre]
  rfl

end ConvergeAudit
