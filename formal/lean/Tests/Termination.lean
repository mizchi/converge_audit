import ConvergeAudit.Termination

namespace Tests.Termination
open ConvergeAudit.Chronology ConvergeAudit.Encounter ConvergeAudit.Termination

def initial : State Nat Nat Nat Nat :=
  { game := { slot := .fresh, retentionUntil := 0 }, start := 5 }
def stopped : State Nat Nat Nat Nat :=
  { game := { slot := .forfeited none, retentionUntil := 30 }, start := 5,
    termination := some ⟨.abandoned, 10⟩ }
def committed : State Nat Nat Nat Nat := { initial with game.slot := .locked 7 9 }
def revealed : State Nat Nat Nat Nat := { initial with game.slot := .revealed 7 9 10 777 }
def settled : State Nat Nat Nat Nat :=
  { initial with game.slot := .consumed 7 9 10 777, game.reward := some 784 }

example : close 10 20 10 .abandoned initial = some stopped := by decide
example : close 9 20 10 .expired initial = none := by decide
example : close 10 20 10 .expired initial = some { stopped with termination := some ⟨.expired, 10⟩ } := by decide
example : close 10 20 10 .expired committed = none := by decide
example : close 10 20 10 .expired revealed = none := by decide
example : close 10 20 10 .abandoned settled = none := by decide
example : close 99 100 10 .expired stopped = some stopped := by decide
example : (close 10 20 10 .abandoned committed).isSome = true := by decide
example : (close 10 20 10 .abandoned revealed).isSome = true := by decide
example : cleanup 29 stopped = none := by decide
example : cleanup 30 { stopped with game.held := true } = none := by decide
example : cleanup 30 stopped = some { stopped with game.retired := true } := by decide
example : finish (fun r s => r + s) 7 stopped.game = none := by decide
example : marketRead stopped.game = none := by decide
example : cleanup 30 initial = none := by decide
example : (close 10 20 10 .abandoned committed).map (fun s => pinned s.game.slot) = some (some 7) := by decide

end Tests.Termination
