import ConvergeAudit.Trace

namespace ConvergeAudit

variable {State Command : Type}

/-- Model obligation for an honest watcher with the full transcript, a correct
kernel, enough time and an uncensored challenge channel before the deadline. -/
def ChallengeComplete (step : State → Command → State) (inputs : Nat → Command)
    (trace : Nat → State) (n : Nat) (raised : Nat → Prop) : Prop :=
  ∀ i, i < n → trace (i + 1) ≠ step (trace i) (inputs i) → raised i

theorem optimistic_finality_sound (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n : Nat) (raised : Nat → Prop)
    (start : trace 0 = initial)
    (coverage : ChallengeComplete step inputs trace n raised)
    (silence : ∀ i, i < n → ¬ raised i) :
    ValidTrace step initial inputs trace n := by
  classical
  refine ⟨start, ?_⟩
  intro i hi
  apply Classical.byContradiction
  intro bad
  exact silence i hi (coverage i hi bad)

/-- Facts established by the admission boundary, never untrusted client fields.
`verified` represents replay or a sound certificate for this exact checkpoint.
Coverage is an environmental obligation, not a locally observable boolean. -/
structure FinalityFacts where
  available : Bool := false
  parentFinal : Bool := false
  challenged : Bool := false
  verified : Bool := false
  windowClosed : Bool := false
  timelyHonestCoverage : Bool := false

def mayFinalize (facts : FinalityFacts) : Bool :=
  facts.available && facts.parentFinal && !facts.challenged &&
    (facts.verified || (facts.windowClosed && facts.timelyHonestCoverage))

theorem may_finalize_iff (facts : FinalityFacts) :
    mayFinalize facts = true ↔
      facts.available = true ∧ facts.parentFinal = true ∧ facts.challenged = false ∧
        (facts.verified = true ∨
          facts.windowClosed = true ∧ facts.timelyHonestCoverage = true) := by
  simp [mayFinalize, Bool.and_eq_true, Bool.or_eq_true, and_assoc]

/-- Semantic bindings for the exact input/trace under consideration. Neither a
signature nor a client-provided boolean constructs this evidence on its own. -/
structure FinalityEvidence (step : State → Command → State) (initial : State)
    (inputs : Nat → Command) (trace : Nat → State) (n : Nat) (raised : Nat → Prop)
    (facts : FinalityFacts) : Prop where
  trustedStart : trace 0 = initial
  verifiedSound : facts.verified = true → ValidTrace step initial inputs trace n
  coverageSound : facts.timelyHonestCoverage = true →
    ChallengeComplete step inputs trace n raised
  closedSilence : facts.windowClosed = true → facts.challenged = false →
    ∀ i, i < n → ¬ raised i

/-- Connect the executable admission gate to trace validity, rather than merely
proving isolated boolean refusal cases. Environmental assumptions stay explicit. -/
theorem finality_gate_sound
    {step : State → Command → State} {initial : State} {inputs : Nat → Command}
    {trace : Nat → State} {n : Nat} {raised : Nat → Prop} {facts : FinalityFacts}
    (evidence : FinalityEvidence step initial inputs trace n raised facts)
    (accepted : mayFinalize facts = true) : ValidTrace step initial inputs trace n := by
  obtain ⟨_, _, noChallenge, justification⟩ := (may_finalize_iff facts).mp accepted
  cases justification with
  | inl verified => exact evidence.verifiedSound verified
  | inr watched =>
    exact optimistic_finality_sound step initial inputs trace n raised evidence.trustedStart
      (evidence.coverageSound watched.2) (evidence.closedSilence watched.1 noChallenge)

theorem finalized_output_matches_run
    {step : State → Command → State} {initial : State} {inputs : Nat → Command}
    {trace : Nat → State} {n : Nat} {raised : Nat → Prop} {facts : FinalityFacts}
    (evidence : FinalityEvidence step initial inputs trace n raised facts)
    (accepted : mayFinalize facts = true) : trace n = run step initial inputs n :=
  valid_trace_matches_run step initial inputs trace n (finality_gate_sound evidence accepted)

theorem no_unchecked_finality (facts : FinalityFacts)
    (unchecked : facts.verified = false) (uncovered : facts.timelyHonestCoverage = false) :
    mayFinalize facts = false := by
  simp [mayFinalize, unchecked, uncovered]

theorem challenged_never_finalizes (facts : FinalityFacts)
    (challenge : facts.challenged = true) : mayFinalize facts = false := by
  simp [mayFinalize, challenge]

theorem pending_parent_never_finalizes (facts : FinalityFacts)
    (pending : facts.parentFinal = false) : mayFinalize facts = false := by
  simp [mayFinalize, pending]

/-- With n fixed identities and at most f Byzantine identities, 2q > n+f
is the intersection requirement; majority alone is insufficient for BFT. This
is arithmetic only, not a proof of a complete quorum protocol. -/
theorem byzantine_quorum_bounds (n q f : Nat)
    (bounded : q ≤ n) (intersection : n + f < 2 * q) :
    f < q ∧ n + f - q < q := by omega

end ConvergeAudit
