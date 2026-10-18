import ConvergeAudit.Encounter

open ConvergeAudit.Chronology ConvergeAudit.Encounter

namespace Tests.Encounter

def replay (root seed : Nat) := root + seed
def schedule : Schedule Nat := { releaseAt := 10, seed := 777 }
def opened : Record Nat Nat Nat :=
  { slot := .revealed 11 9 10 777, retentionUntil := 20 }
def completed : Record Nat Nat Nat :=
  { opened with slot := .consumed 11 9 10 777, reward := some 788 }

example : finish replay 11 opened = some completed := by decide
example : finish replay 12 opened = none := by decide
example : finish replay 11 { opened with slot := .locked 11 9 } = none := by decide
example : finish replay 11 completed = none := by decide
example : marketRead completed = some 788 := by decide
example : marketRead { completed with held := true } = none := by decide
example : marketRead opened = none := by decide
example : retire 19 completed = none := by decide
example : retire 20 { completed with held := true } = none := by decide
example : retire 20 opened = none := by decide
example : retire 20 completed = some { completed with retired := true } := by decide
example : setHold true { completed with retired := true } = none := by decide
example : setHold false { completed with retired := true } = none := by decide

-- The seed and the input root here are the SAME ones as the timed reveal.
example : (788 : Nat) = replay 11 schedule.seed := by
  exact finalized_reward_uses_scheduled_seed schedule replay 11 opened completed 788
    (by simp [opened, schedule, WellTimed]) (by decide) (by decide)

-- A consumed start cannot be refunded by presenting a different candidate.
def emptyLedger (_ : Nat) : Option Nat := none
example : reserve emptyLedger 5 100 5 = some 100 := by decide
example : reserve (reserve emptyLedger 5 100) 5 200 5 = some 100 := by decide
example : reserve emptyLedger 5 100 6 = none := by decide

end Tests.Encounter
