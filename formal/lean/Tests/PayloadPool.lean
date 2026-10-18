import ConvergeAudit.PayloadPool

open ConvergeAudit.Retention ConvergeAudit.PayloadPool

namespace Tests.PayloadPool

def globalBudget : Budget := { maxBytes := 12, reservedBytes := 2, maxItems := 3, maxItemBytes := 8 }
def localBudget : Budget := { maxBytes := 20, reservedBytes := 2, maxItems := 4, maxItemBytes := 8 }
def five : Chunk := { bytes := 5 }
def six : Chunk := { bytes := 6 }
def safe : Chunk := { bytes := 5, acknowledged := true, finalized := true, retentionClosed := true }

example : scopedAdmit globalBudget localBudget five [five] [] [] = some [five] := by decide
-- Both queues would fit separately; their total would violate the global budget.
example : admit localBudget six [] = some [six] := by decide
example : scopedAdmit globalBudget localBudget six [six] [] [] = none := by decide
example : scopedAdmit globalBudget localBudget five [five, five] [] [] = none := by decide
example : registerScope 2 3 = some 3 := by decide
example : registerScope 3 3 = none := by decide
example : registerScope 0 0 = none := by decide
example : releaseScope 1 [five] true true = none := by decide
example : releaseScope 1 [] true false = none := by decide
example : releaseScope 1 [] true true = some 0 := by decide
example : releaseScope 1 [] false false = some 0 := by decide

example : Fits globalBudget ([five] ++ [five] ++ []) :=
  scoped_admission_global_fits globalBudget localBudget five [five] [] [] [five] (by decide)
example : Fits globalBudget ([] ++ (prunePrefix [safe]).2 ++ [five]) :=
  scoped_prune_preserves_global_fit globalBudget [] [safe] [five] (by decide)

def fresh : Stamp := freshStamp 10
example : fresh.incarnation = 11 ∧ fresh.revision = 11 := by decide
example : WellStamped 11 fresh := by decide
example : ¬ ((10 : Nat) = fresh.revision) := by decide
example : WellStamped 12 (touchStamp 11 fresh) :=
  touched_stamp_well_formed 11 fresh (by decide)

example : (10 : Nat) ≠ (touchStamp 11 fresh).revision :=
  old_grant_cannot_match_recreated_scope 10 10 12 (touchStamp 11 fresh)
    (by decide) rfl (touched_stamp_well_formed 11 fresh (by decide))

end Tests.PayloadPool
