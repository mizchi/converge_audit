import ConvergeAudit.Merkle

namespace ConvergeAudit

open Merkle

variable {State Command Context Digest : Type}

def stateMetadata (context : Context) (n : Nat) : Metadata Context := ⟨context, .states, n + 1⟩
def commandMetadata (context : Context) (n : Nat) : Metadata Context := ⟨context, .commands, n⟩

def stateValues (trace : Nat → State) (n : Nat) : Nat → Option (Sum State Command) :=
  fun i => if i < n + 1 then some (.inl (trace i)) else none

def commandValues (inputs : Nat → Command) (n : Nat) : Nat → Option (Sum State Command) :=
  fun i => if i < n then some (.inr (inputs i)) else none

def stateTree (trace : Nat → State) (n depth : Nat) : Tree (Option (Sum State Command)) depth :=
  tabulate depth (stateValues trace n)

def commandTree (inputs : Nat → Command) (n depth : Nat) : Tree (Option (Sum State Command)) depth :=
  tabulate depth (commandValues inputs n)

def stateCommitment (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (n : Nat) (trace : Nat → State) : Digest :=
  commitRoot hash (stateMetadata context n) (stateTree trace n (ceilLog2 (n + 1)))

def commandCommitment (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (n : Nat) (inputs : Nat → Command) : Digest :=
  commitRoot hash (commandMetadata context n) (commandTree inputs n (ceilLog2 n))

/-- Padding is a dedicated `none` leaf. Neither uncommitted future values nor
an arbitrary default state/command may change the root of the fixed prefix. -/
theorem state_commitment_prefix_ext (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (n : Nat) (first second : Nat → State)
    (same : ∀ i, i < n + 1 → first i = second i) :
    stateCommitment hash context n first = stateCommitment hash context n second := by
  have valuesEqual : stateValues (Command := Command) first n = stateValues second n := by
    funext i
    unfold stateValues
    split
    next inside => rw [same i inside]
    next => rfl
  unfold stateCommitment stateTree
  rw [valuesEqual]

theorem command_commitment_prefix_ext (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (n : Nat) (first second : Nat → Command)
    (same : ∀ i, i < n → first i = second i) :
    commandCommitment hash context n first = commandCommitment hash context n second := by
  have valuesEqual : commandValues (State := State) first n = commandValues second n := by
    funext i
    unfold commandValues
    split
    next inside => rw [same i inside]
    next => rfl
  unfold commandCommitment commandTree
  rw [valuesEqual]

theorem empty_command_commitment (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (first second : Nat → Command) :
    commandCommitment hash context 0 first = commandCommitment hash context 0 second := by
  apply command_commitment_prefix_ext
  intro i inside
  omega

structure FraudProof (State Command Digest : Type) (stateDepth commandDepth : Nat) where
  index : Nat
  before : State
  after : State
  command : Command
  beforePath : Path Digest stateDepth
  afterPath : Path Digest stateDepth
  commandPath : Path Digest commandDepth

def verifyFraud [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (stateRoot commandRoot : Digest) (step : State → Command → State)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth) : Bool :=
  decide (proof.index < n) &&
    verifyOpening hash (stateMetadata context n) proof.index (.some (.inl proof.before)) proof.beforePath stateRoot &&
    verifyOpening hash (stateMetadata context n) (proof.index + 1) (.some (.inl proof.after)) proof.afterPath stateRoot &&
    verifyOpening hash (commandMetadata context n) proof.index (.some (.inr proof.command)) proof.commandPath commandRoot &&
    decide (proof.after ≠ step proof.before proof.command)

theorem verify_fraud_iff [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (stateRoot commandRoot : Digest) (step : State → Command → State)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth) :
    verifyFraud hash context n stateRoot commandRoot step proof = true ↔
      proof.index < n ∧
      verifyOpening hash (stateMetadata context n) proof.index (.some (.inl proof.before)) proof.beforePath stateRoot = true ∧
      verifyOpening hash (stateMetadata context n) (proof.index + 1) (.some (.inl proof.after)) proof.afterPath stateRoot = true ∧
      verifyOpening hash (commandMetadata context n) proof.index (.some (.inr proof.command)) proof.commandPath commandRoot = true ∧
      proof.after ≠ step proof.before proof.command := by
  simp [verifyFraud, Bool.and_eq_true, and_assoc]

def fraudPresentedInputs (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth) :
    List (HashInput (Option (Sum State Command)) Context Digest) :=
  openingInputs hash (stateMetadata context n) (.some (.inl proof.before)) proof.beforePath ++
  openingInputs hash (stateMetadata context n) (.some (.inl proof.after)) proof.afterPath ++
  openingInputs hash (commandMetadata context n) (.some (.inr proof.command)) proof.commandPath

def fraudCommittedInputs (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (trace : Nat → State) (inputs : Nat → Command) (stateDepth commandDepth : Nat) :
    List (HashInput (Option (Sum State Command)) Context Digest) :=
  committedInputs hash (stateMetadata context n) (stateTree trace n stateDepth) ++
  committedInputs hash (commandMetadata context n) (commandTree inputs n commandDepth)

def FraudCollision (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (trace : Nat → State) (inputs : Nat → Command)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth) : Prop :=
  CollisionOn hash (fraudPresentedInputs hash context n proof)
    (fraudCommittedInputs hash context n trace inputs stateDepth commandDepth)

/-- The authentication equalities formerly supplied to the one-step theorem are
now derived from three accepted openings, or expose a local hash collision. -/
theorem verified_fraud_refutes_or_collision [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (step : State → Command → State) (initial : State) (trace : Nat → State) (inputs : Nat → Command)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth)
    (accepted : verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step proof = true) :
    ¬ ValidTrace step initial inputs trace n ∨ FraudCollision hash context n trace inputs proof := by
  obtain ⟨inside, before, after, command, bad⟩ := (verify_fraud_iff _ _ _ _ _ _ _).mp accepted
  have beforeInside : proof.index < n + 1 := by omega
  have afterInside : proof.index + 1 < n + 1 := by omega
  have stateDepthMatches := ((verify_opening_iff _ _ _ _ _ _).mp before).1.2.2.2
  have commandDepthMatches := ((verify_opening_iff _ _ _ _ _ _).mp command).1.2.2.2
  change stateDepth = ceilLog2 (n + 1) at stateDepthMatches
  change commandDepth = ceilLog2 n at commandDepthMatches
  subst stateDepth
  subst commandDepth
  cases opening_for_vector hash (stateMetadata context n) (stateMetadata context n)
      (stateValues trace n) proof.index (.some (.inl proof.before)) proof.beforePath before with
  | inr collision =>
    apply Or.inr
    apply collision_mono hash collision
    · intro a ha
      simp only [fraudPresentedInputs, List.mem_append]
      simp [ha]
    · intro b hb
      simp only [fraudCommittedInputs, List.mem_append]
      exact Or.inl hb
  | inl correctBefore =>
    cases opening_for_vector hash (stateMetadata context n) (stateMetadata context n)
        (stateValues trace n) (proof.index + 1) (.some (.inl proof.after)) proof.afterPath after with
    | inr collision =>
      apply Or.inr
      apply collision_mono hash collision
      · intro a ha
        simp only [fraudPresentedInputs, List.mem_append]
        simp [ha]
      · intro b hb
        simp only [fraudCommittedInputs, List.mem_append]
        exact Or.inl hb
    | inl correctAfter =>
      cases opening_for_vector hash (commandMetadata context n) (commandMetadata context n)
          (commandValues inputs n) proof.index (.some (.inr proof.command)) proof.commandPath command with
      | inr collision =>
        apply Or.inr
        apply collision_mono hash collision
        · intro a ha
          simp only [fraudPresentedInputs, List.mem_append]
          simp [ha]
        · intro b hb
          simp only [fraudCommittedInputs, List.mem_append]
          exact Or.inr hb
      | inl correctCommand =>
        have beforeEqual : proof.before = trace proof.index := by
          simpa [stateValues, beforeInside] using correctBefore.2
        have afterEqual : proof.after = trace (proof.index + 1) := by
          simpa [stateValues, afterInside] using correctAfter.2
        have commandEqual : proof.command = inputs proof.index := by
          simpa [commandValues, inside] using correctCommand.2
        exact Or.inl (authenticated_bad_step_refutes_trace step initial inputs trace n proof.index
          proof.before proof.after proof.command inside beforeEqual afterEqual commandEqual bad)

theorem verified_fraud_refutes [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (step : State → Command → State) (initial : State) (trace : Nat → State) (inputs : Nat → Command)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth)
    (noCollision : ¬ FraudCollision hash context n trace inputs proof)
    (accepted : verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step proof = true) : ¬ ValidTrace step initial inputs trace n := by
  cases verified_fraud_refutes_or_collision hash context n step initial trace inputs proof accepted with
  | inl invalid => exact invalid
  | inr collision => exact False.elim (noCollision collision)

def makeFraudProof (hash : Hasher (Option (Sum State Command)) Context Digest)
    (trace : Nat → State) (inputs : Nat → Command) (n index : Nat) :
    FraudProof State Command Digest (ceilLog2 (n + 1)) (ceilLog2 n) :=
  { index := index
    before := trace index
    after := trace (index + 1)
    command := inputs index
    beforePath := makePath hash (stateTree trace n (ceilLog2 (n + 1))) index
    afterPath := makePath hash (stateTree trace n (ceilLog2 (n + 1))) (index + 1)
    commandPath := makePath hash (commandTree inputs n (ceilLog2 n)) index }

theorem generated_fraud_accepted [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n index : Nat)
    (step : State → Command → State) (trace : Nat → State) (inputs : Nat → Command)
    (inside : index < n) (bad : trace (index + 1) ≠ step (trace index) (inputs index)) :
    verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step (makeFraudProof hash trace inputs n index) = true := by
  apply (verify_fraud_iff _ _ _ _ _ _ _).mpr
  have beforeInside : index < n + 1 := by omega
  have afterInside : index + 1 < n + 1 := by omega
  refine ⟨inside, ?_, ?_, ?_, bad⟩
  · have opened := vector_opening_accepted hash (stateMetadata context n) (stateValues trace n) index
      (by simp [stateMetadata]) beforeInside rfl
    have valueEq : stateValues (Command := Command) trace n index = some (Sum.inl (trace index)) := by
      simp [stateValues, beforeInside]
    rw [valueEq] at opened
    exact opened
  · have opened := vector_opening_accepted hash (stateMetadata context n) (stateValues trace n) (index + 1)
      (by simp [stateMetadata]) afterInside rfl
    have valueEq : stateValues (Command := Command) trace n (index + 1) = some (Sum.inl (trace (index + 1))) := by
      simp [stateValues, afterInside]
    rw [valueEq] at opened
    exact opened
  · have opened := vector_opening_accepted hash (commandMetadata context n) (commandValues inputs n) index
      (by change 0 < n; omega) inside rfl
    have valueEq : commandValues (State := State) inputs n index = some (Sum.inr (inputs index)) := by
      simp [commandValues, inside]
    rw [valueEq] at opened
    exact opened

theorem wrong_output_has_accepted_fraud [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (step : State → Command → State) (initial : State) (trace : Nat → State) (inputs : Nat → Command)
    (start : trace 0 = initial) (wrong : trace n ≠ run step initial inputs n) :
    ∃ index, index < n ∧ verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step (makeFraudProof hash trace inputs n index) = true := by
  obtain ⟨index, inside, bad⟩ := wrong_output_has_bad_step step initial inputs trace n start wrong
  exact ⟨index, inside, generated_fraud_accepted hash context n index step trace inputs inside bad⟩

theorem localized_fraud_accepted [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (step : State → Command → State) (initial : State) (trace : Nat → State) (inputs : Nat → Command)
    (start : trace 0 = initial) (wrong : trace n ≠ run step initial inputs n) :
    ∃ result, locateRange (run step initial inputs) trace 0 n = some result ∧
      result.queries ≤ ceilLog2 n ∧
      verifyFraud hash context n (stateCommitment hash context n trace)
        (commandCommitment hash context n inputs) step
        (makeFraudProof hash trace inputs n result.index) = true := by
  obtain ⟨result, found, inside, queries, bad⟩ := located_range_step_is_fraud step initial inputs trace n start wrong
  exact ⟨result, found, queries,
    generated_fraud_accepted hash context n result.index step trace inputs inside bad⟩

theorem fraud_opening_inputs_length (hash : Hasher (Option (Sum State Command)) Context Digest)
    (context : Context) (n : Nat) {stateDepth commandDepth : Nat}
    (proof : FraudProof State Command Digest stateDepth commandDepth) :
    (fraudPresentedInputs hash context n proof).length = 2 * stateDepth + commandDepth + 6 := by
  simp only [fraudPresentedInputs, List.length_append, opening_inputs_length]
  omega

theorem accepted_fraud_hash_budget [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (stateRoot commandRoot : Digest) (step : State → Command → State)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth)
    (accepted : verifyFraud hash context n stateRoot commandRoot step proof = true) :
    (fraudPresentedInputs hash context n proof).length =
      2 * ceilLog2 (n + 1) + ceilLog2 n + 6 := by
  obtain ⟨_, before, _, command, _⟩ := (verify_fraud_iff _ _ _ _ _ _ _).mp accepted
  have states := ((verify_opening_iff _ _ _ _ _ _).mp before).1.2.2.2
  have commands := ((verify_opening_iff _ _ _ _ _ _).mp command).1.2.2.2
  change stateDepth = ceilLog2 (n + 1) at states
  change commandDepth = ceilLog2 n at commands
  rw [fraud_opening_inputs_length, states, commands]

theorem out_of_range_fraud_rejected [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (stateRoot commandRoot : Digest) (step : State → Command → State)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth)
    (outside : n ≤ proof.index) : verifyFraud hash context n stateRoot commandRoot step proof = false := by
  have notInside : ¬ proof.index < n := by omega
  simp [verifyFraud, notInside]

theorem valid_trace_rejects_without_collision [DecidableEq State] [DecidableEq Digest]
    (hash : Hasher (Option (Sum State Command)) Context Digest) (context : Context) (n : Nat)
    (step : State → Command → State) (initial : State) (trace : Nat → State) (inputs : Nat → Command)
    {stateDepth commandDepth : Nat} (proof : FraudProof State Command Digest stateDepth commandDepth)
    (valid : ValidTrace step initial inputs trace n) (noCollision : ¬ FraudCollision hash context n trace inputs proof) :
    verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step proof = false := by
  cases outcome : verifyFraud hash context n (stateCommitment hash context n trace)
      (commandCommitment hash context n inputs) step proof with
  | false => rfl
  | true => exact False.elim (verified_fraud_refutes hash context n step initial trace inputs proof noCollision outcome valid)

end ConvergeAudit
