import ConvergeAudit
import Tests.Reservation
import Tests.Termination
import Tests.Recovery
import Tests.Cases
import Tests.Archive
import Tests.InventoryCompaction
import Tests.Generations
import Tests.RecoveryRelease
import Tests.EmptyInventory
import Tests.Merkle
import Tests.Fraud
import Tests.Chronology
import Tests.Visibility
import Tests.Retention
import Tests.Encounter
import Tests.PayloadPool

open ConvergeAudit

namespace Tests

def step (state command : Nat) : Nat := state + command
def inputs (_ : Nat) : Nat := 1
def honest : Nat → Nat := run step 0 inputs
def forged (i : Nat) : Nat := if i < 2 then i else i + 100

-- Honest execution and a fabricated reward, under the SAME committed inputs.
example : run step 0 inputs 4 = 4 := by decide
example : ValidTrace step 0 inputs honest 4 := run_valid step 0 inputs 4
example : ¬ ValidTrace step 0 inputs forged 4 := by
  intro h
  have := h.2 1 (by decide)
  contradiction
example : locate honest forged 0 2 = 1 := by decide
example : checkStep step inputs forged 1 = false := by decide
example : ¬ ValidTrace step 0 inputs (fun _ => 99) 0 := by
  intro h
  exact (by decide : (99 : Nat) ≠ 0) h.1
example : ValidTrace step 0 inputs honest 0 := run_valid step 0 inputs 0

-- Bisection needs no "once different, always different" assumption.
def reconverging (i : Nat) : Nat := if i = 1 ∨ i = 3 ∨ i = 4 then i + 10 else i
example : locate honest reconverging 0 2 = 2 := by decide

-- Checking only conservation of currency misses teleportation.
def avatarStep (s : Nat × Nat) (_ : Unit) : Nat × Nat := (s.1, s.2 + 1)
def avatarTrace (i : Nat) : Nat × Nat := (10, if i = 0 then 0 else 100)
example : (avatarTrace 0).1 = (avatarTrace 1).1 := by decide
example : checkStep avatarStep (fun _ => ()) avatarTrace 0 = false := by
  decide

-- Full replay also accepts invented commands unless the input boundary checks receipts.
example : ValidTrace step 0 (fun _ => 101) (run step 0 (fun _ => 101)) 1 :=
  run_valid step 0 (fun _ => 101) 1
example : run step 0 (fun _ => 101) 1 ≠ run step 0 inputs 1 := by decide

-- Authenticated openings reject a forged reward and cannot refute an honest edge.
example : ¬ ValidTrace step 0 inputs forged 4 := by
  exact authenticated_bad_step_refutes_trace step 0 inputs forged 4 1 1 102 1
    (by decide) rfl (by decide) rfl (by decide)
example : checkStep step inputs honest 1 = true := by decide

-- A sample that misses the corrupt edge accepts an invalid execution.
example : checkStep step inputs forged 0 = true ∧
    checkStep step inputs forged 1 = false := by decide
example : missNumerator 1024 1 32 = 1023 ^ 32 := by decide
example : ¬ (missNumerator 1024 1 32 = 0) := by decide

-- Timeout alone cannot turn an unchecked claim into finality.
example : mayFinalize { available := true, parentFinal := true, windowClosed := true } = false := by
  decide
example : mayFinalize { available := true, parentFinal := true, verified := true } = true := by
  decide
example : mayFinalize
    { available := true, parentFinal := true, windowClosed := true, timelyHonestCoverage := true } = true := by
  decide
example : mayFinalize
    { available := true, parentFinal := true, timelyHonestCoverage := true } = false := by decide
example : mayFinalize
    { available := true, parentFinal := true, verified := true, challenged := true } = false := by decide
example : mayFinalize { available := true, verified := true } = false := by decide
example : mayFinalize
    { parentFinal := true, verified := true, windowClosed := true, timelyHonestCoverage := true } = false := by
  decide

-- Non-power-of-two batches must not require a fabricated padding transition.
example : ceilLog2 0 = 0 ∧ ceilLog2 1 = 0 ∧ ceilLog2 3 = 2 ∧
    ceilLog2 1025 = 11 := by decide
example : locateRange honest forged 0 3 = some { index := 1, queries := 2 } := by decide
example : locateRange honest forged 0 0 = none := by decide
example : locateRange honest forged 1 1 = some { index := 1, queries := 0 } := by decide
example : locateRange honest reconverging 0 3 = some { index := 0, queries := 1 } := by decide

-- Acceptance is linked to the same trace's semantic evidence, not a free boolean.
def verifiedFacts : FinalityFacts :=
  { available := true, parentFinal := true, verified := true }

example (evidence : FinalityEvidence step 0 inputs forged 4 (fun _ => False) verifiedFacts) :
    False := by
  have valid := finality_gate_sound evidence (by decide)
  have invalid : ¬ ValidTrace step 0 inputs forged 4 := by
    intro h
    have := h.2 1 (by decide)
    contradiction
  exact invalid valid

example : FinalityEvidence step 0 inputs honest 4 (fun _ => False) verifiedFacts := by
  refine ⟨rfl, fun _ => run_valid step 0 inputs 4, ?_, ?_⟩
  · intro _ i _ bad
    exact bad rfl
  · intro _ _ _ _ impossible
    exact impossible

-- A later checkpoint is valid from the certified parent's final state.
def secondInputs (_ : Nat) : Nat := 2
def secondTrace : Nat → Nat := run step 2 secondInputs
example : run step 0 (concatInputs inputs secondInputs 2) 4 = 6 := by decide
example : secondTrace 2 = run step 0 (concatInputs inputs secondInputs 2) (2 + 2) := by
  exact valid_checkpoints_compose step 0 inputs honest 2 secondInputs secondTrace 2
    (run_valid step 0 inputs 2) (run_valid step 2 secondInputs 2)
example : ¬ ValidTrace step (honest 2) secondInputs (run step 999 secondInputs) 2 := by
  intro h
  have : (999 : Nat) = 2 := h.1
  contradiction
example : run step 0 (concatInputs inputs secondInputs 0) 3 = 6 := by decide

-- A game-specific kernel invariant is carried through certified finalization.
def cappedStep (state command : Nat) : Nat :=
  if state + command ≤ 10 then state + command else state

theorem capped_preserves : Preserves cappedStep (fun state => state ≤ 10) := by
  intro state command safe
  unfold cappedStep
  split
  next allowed => exact allowed
  next => exact safe

example (commands : Nat → Nat) (n : Nat) : run cappedStep 0 commands n ≤ 10 :=
  run_preserves_invariant cappedStep (fun state => state ≤ 10) 0 commands n
    capped_preserves (by decide)

example {commands trace : Nat → Nat} {n : Nat} {raised : Nat → Prop} {facts : FinalityFacts}
    (evidence : FinalityEvidence cappedStep 0 commands trace n raised facts)
    (accepted : mayFinalize facts = true) : trace n ≤ 10 :=
  finalized_invariant (fun state => state ≤ 10) capped_preserves (by decide) evidence accepted

-- Matching endpoints do not certify the intermediate history.
def cancelled (i : Nat) : Nat := if i = 1 then 100 else i
example : cancelled 2 = honest 2 := by decide
example : ¬ ValidTrace step 0 inputs cancelled 2 := by
  intro valid
  have bad := valid.2 0 (by decide)
  contradiction

-- Count each fixed roster slot once; duplicate signature packets do not add identities.
def quorumA (i : Nat) : Bool := decide (i < 3)
def quorumB (i : Nat) : Bool := decide (0 < i)
def faulty (i : Nat) : Bool := decide (i = 1)
example : countMembers quorumA 4 = 3 ∧ countMembers quorumB 4 = 3 ∧
    countMembers faulty 4 = 1 := by decide
example : ∃ i, i < 4 ∧ quorumA i = true ∧ quorumB i = true ∧ faulty i = false := by
  exact honest_quorum_intersection quorumA quorumB faulty 4 3 1
    (by decide) (by decide) (by decide) (by decide)

-- For n=3,f=1,q=2, plain majority can intersect only at a Byzantine signer.
def weakA (i : Nat) : Bool := decide (i = 0 ∨ i = 1)
def weakB (i : Nat) : Bool := decide (i = 0 ∨ i = 2)
example : countMembers weakA 3 = 2 ∧ countMembers weakB 3 = 2 ∧
    countMembers (fun i => weakA i && weakB i) 3 = 1 := by decide
example : 3 < 2 * 2 ∧ ¬ (3 + 1 < 2 * 2) := by decide

example (signed : Nat → Nat → Prop)
    (first : ∀ i, i < 4 → quorumA i = true → signed i 5)
    (second : ∀ i, i < 4 → quorumB i = true → signed i 9)
    (once : ∀ i, i < 4 → faulty i = false → ∀ a b, signed i a → signed i b → a = b) :
    False := by
  have incompatible := quorum_decisions_unique quorumA quorumB faulty 4 3 1 signed 5 9
    (by decide) (by decide) (by decide) (by decide) first second once
  contradiction

end Tests
