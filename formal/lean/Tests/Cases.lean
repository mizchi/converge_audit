import ConvergeAudit.Cases
namespace Tests.Cases
open ConvergeAudit.Cases
def record : Case := ⟨7, none, false⟩
def two : Registry 2 := ⟨fun _ => some record, false, false, 2⟩
def decided : Registry 2 := { two with entries := fun _ => some ⟨7, some 9, false⟩ }
example : close 2 two = none := by decide
example : close 2 decided = none := by decide
example : (acknowledge 0 8 9 true decided).isNone = true := by decide
example : (acknowledge 0 7 10 true decided).isNone = true := by decide
example : (acknowledge 0 7 9 false decided).isNone = true := by decide
example : (acknowledge 0 7 9 true decided).bind (close 2) = none := by decide
example : (((acknowledge 0 7 9 true decided).bind (acknowledge 1 7 9 true)).bind (close 2)).isSome = true := by decide
def empty : Registry 2 := ⟨fun _ => none, false, false, 0⟩
example : (place 0 7 empty).bind (close 0) = none := by decide
example : (close 0 empty).bind (place 0 7) = none := by decide
-- A single shared boolean would release evidence despite the other live case.
example : two.manualHold = false ∧ active (two.entries 1) = true := by decide
def game : ConvergeAudit.Encounter.Record Nat Nat Nat :=
  { slot := .consumed 1 3 4 7, reward := some 11, retentionUntil := 5 }
example : ConvergeAudit.Encounter.marketRead (attachCases two game) = none := by decide
example : ConvergeAudit.Encounter.marketRead (attachCases empty game) = some 11 := by decide
example : ConvergeAudit.Encounter.retire 5 (attachCases decided game) = none := by decide
example : ConvergeAudit.Encounter.retire 5 (attachCases empty { game with held := true }) = none := by decide
end Tests.Cases
