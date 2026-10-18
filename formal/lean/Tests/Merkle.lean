import ConvergeAudit

open ConvergeAudit
open ConvergeAudit.Merkle

namespace Tests.Merkle

inductive Digest where
  | leaf : Nat → Digest
  | node : Digest → Digest → Digest
  | root : Metadata Nat → Digest → Digest
  deriving DecidableEq, Repr

def symbolicHash : HashInput Nat Nat Digest → Digest
  | .leaf value => .leaf value
  | .node left right => .node left right
  | .root metadata content => .root metadata content

def metadata : Metadata Nat := ⟨7, .states, 3⟩
def tree : Tree Nat 2 := tabulate 2 (fun i => i + 10)
def root : Digest := commitRoot symbolicHash metadata tree
def path : Path Digest 2 := .left (.node (.leaf 12) (.leaf 13)) (.right (.leaf 10) .done)

example : path.index = 1 := by decide
example : verifyOpening symbolicHash metadata 1 11 path root = true := by decide
example : verifyOpening symbolicHash metadata 1 99 path root = false := by decide
example : verifyOpening symbolicHash metadata 0 11 path root = false := by decide
example : verifyOpening symbolicHash { metadata with context := 8 } 1 11 path root = false := by decide
example : verifyOpening symbolicHash { metadata with kind := .commands } 1 11 path root = false := by decide
example : verifyOpening symbolicHash { metadata with count := 4 } 1 11 path root = false := by decide
example : verifyOpening symbolicHash { metadata with count := 0 } 1 11 path root = false := by decide
example : verifyOpening symbolicHash metadata 3 13 (.right (.node (.leaf 10) (.leaf 11))
    (.right (.leaf 12) .done)) root = false := by decide
example : makePath symbolicHash tree 1 = path := by rfl
example : verifyOpening symbolicHash metadata 2 12 (makePath symbolicHash tree 2) root = true := by
  decide
example : (openingInputs symbolicHash metadata 11 path).length = 4 := by decide
example : verifyOpening symbolicHash metadata 0 10 (.left (.leaf 11) .done) root = false := by decide
example : verifyOpening symbolicHash metadata 0 10
    (.left (.leaf 0) (.left (.leaf 0) (.left (.leaf 0) .done))) root = false := by decide

-- A deliberately colliding hasher accepts the lie; the theorem must expose a
-- concrete collision from the checked hash inputs rather than claim validity.
def collidingHash (_ : HashInput Nat Nat Unit) : Unit := ()
def collidingPath : Path Unit 2 := .left () (.right () .done)
example : verifyOpening collidingHash metadata 1 99 collidingPath () = true := by decide
example : CollisionOn collidingHash
    (openingInputs collidingHash metadata 99 collidingPath)
    (committedInputs collidingHash metadata tree) := by
  have accepted : verifyOpening collidingHash metadata 1 99 collidingPath
      (commitRoot collidingHash metadata tree) = true := by decide
  have binding := opening_for_vector collidingHash metadata metadata (fun i => i + 10)
    1 99 collidingPath accepted
  cases binding with
  | inl correct => have impossible : (99 : Nat) = 11 := correct.2; contradiction
  | inr collision => exact collision

end Tests.Merkle
