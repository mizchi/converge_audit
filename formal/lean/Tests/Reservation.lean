import ConvergeAudit.Reservation

namespace Tests.Reservation
open ConvergeAudit.Reservation

def empty : Pool := ⟨0, 0, 0, 0, 10, 3⟩
def credit : Credit := ⟨8, 2, 8, 2, 0⟩
def reserved : Pool := ⟨0, 0, 8, 2, 10, 3⟩
def partlyUsed : Pool := ⟨3, 1, 5, 1, 10, 3⟩
def partialCredit : Credit := ⟨8, 2, 5, 1, 1⟩

example : reserve empty 8 2 = some (reserved, credit) := by decide
example : reserve reserved 3 1 = none := by decide
example : reserve reserved 1 2 = none := by decide
example : reserve empty 0 2 = none := by decide
example : consume reserved credit 3 = some (partlyUsed, partialCredit) := by decide
example : consume partlyUsed partialCredit 4 = some (⟨7, 2, 0, 0, 10, 3⟩, ⟨8, 2, 0, 0, 2⟩) := by decide
example : consume partlyUsed partialCredit 6 = none := by decide
example : consume ⟨7, 2, 0, 0, 10, 3⟩ ⟨8, 2, 0, 0, 2⟩ 1 = none := by decide
example : consume reserved credit 0 = none := by decide
example : consume empty credit 3 = none := by decide
example : prune partlyUsed 3 1 = ⟨0, 0, 5, 1, 10, 3⟩ := by decide
example : reopen credit 8 2 = some credit := by decide
example : reopen partialCredit 8 2 = some partialCredit := by decide
example : reopen partialCredit 9 2 = none := by decide
example : Fits partlyUsed := by decide
example : WellFormed partialCredit := by decide
example : releaseClosed partlyUsed partialCredit 3 1 = empty := by decide
example : releaseClosed reserved credit 0 0 = empty := by decide

end Tests.Reservation
