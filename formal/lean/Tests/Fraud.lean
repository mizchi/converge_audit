import ConvergeAudit

open ConvergeAudit
open ConvergeAudit.Merkle

namespace Tests.Fraud

inductive Digest where
  | leaf : Option (Sum Nat Nat) → Digest
  | node : Digest → Digest → Digest
  | root : Metadata Nat → Digest → Digest
  deriving DecidableEq, Repr

def hash : Hasher (Option (Sum Nat Nat)) Nat Digest
  | .leaf value => .leaf value
  | .node left right => .node left right
  | .root metadata content => .root metadata content

def step (state command : Nat) : Nat := state + command
def inputs (_ : Nat) : Nat := 1
def forged (i : Nat) : Nat := if i < 2 then i else i + 100
def proof := makeFraudProof hash forged inputs 3 1
def states := stateCommitment hash 7 3 forged
def commands := commandCommitment hash 7 3 inputs

example : verifyFraud hash 7 3 states commands step proof = true := by decide
example : verifyFraud hash 7 3 states commands step { proof with before := 99 } = false := by decide
example : verifyFraud hash 7 3 states commands step { proof with command := 2 } = false := by decide
example : verifyFraud hash 8 3 states commands step proof = false := by decide
example : verifyFraud hash 7 3 commands states step proof = false := by decide
example : verifyFraud hash 7 3 states commands step { proof with index := 3 } = false := by decide
example : verifyFraud hash 7 0 states commands step proof = false := by decide
example : verifyFraud hash 7 2 states commands step proof = false := by decide
example : verifyFraud hash 7 3 states commands step { proof with afterPath := proof.beforePath } = false := by
  decide

def honest := run step 0 inputs
example : verifyFraud hash 7 3 (stateCommitment hash 7 3 honest) commands step
    (makeFraudProof hash honest inputs 3 1) = false := by decide

-- Deliberately broken hashing must produce a collision witness for a false accusation.
def collidingHash (_ : HashInput (Option (Sum Nat Nat)) Nat Unit) : Unit := ()
def falseAccusation := { makeFraudProof collidingHash honest inputs 3 1 with after := 99 }
example : verifyFraud collidingHash 7 3 () () step falseAccusation = true := by decide
example : FraudCollision collidingHash 7 3 honest inputs falseAccusation := by
  have accepted : verifyFraud collidingHash 7 3 (stateCommitment collidingHash 7 3 honest)
      (commandCommitment collidingHash 7 3 inputs) step falseAccusation = true := by decide
  cases verified_fraud_refutes_or_collision collidingHash 7 3 step 0 honest inputs falseAccusation accepted with
  | inl invalid => exact False.elim (invalid (run_valid step 0 inputs 3))
  | inr collision => exact collision

example : (fraudPresentedInputs hash 7 3 proof).length = 12 := by decide
example : verifyFraud hash 7 1 (stateCommitment hash 7 1 forged) (commandCommitment hash 7 1 inputs)
    step (makeFraudProof hash forged inputs 1 0) = false := by decide

-- Root identity must not depend on values outside the committed log prefix.
example : commandCommitment hash 7 0 (fun _ => 1) = commandCommitment hash 7 0 (fun _ => 99) := by decide
def extendedInputs (i : Nat) : Nat := if i < 3 then 1 else 999
example : commandCommitment hash 7 3 inputs = commandCommitment hash 7 3 extendedInputs := by decide
def extendedTrace (i : Nat) : Nat := if i < 3 then forged i else 999
example : stateCommitment hash 7 2 forged = stateCommitment hash 7 2 extendedTrace := by decide
def singleForgery (i : Nat) : Nat := if i = 0 then 0 else 100
example : verifyFraud hash 7 1 (stateCommitment hash 7 1 singleForgery) (commandCommitment hash 7 1 inputs)
    step (makeFraudProof hash singleForgery inputs 1 0) = true := by decide

end Tests.Fraud
