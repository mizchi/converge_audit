import ConvergeAudit.RecoveryRelease

namespace Tests.RecoveryRelease
open ConvergeAudit.Generations ConvergeAudit.RecoveryRelease

def stopped : Record := ⟨⟨0, 5⟩, 7, none, true, true, false, none⟩
def earned : Record := { stopped with ticket := 8, receipt := some 91 }
def allAck (_ : Nat) : Bool := true
def noAck (_ : Nat) : Bool := false

example : collect 1 allAck [stopped] = [] := by decide
example : collect 1 noAck [stopped] = [stopped] := by decide
example : collect 0 allAck [stopped] = [stopped] := by decide
example : collect 1 allAck [earned, stopped] = [earned] := by decide
example : collect 1 allAck [{ stopped with retired := false }] = [{ stopped with retired := false }] := by decide
example : collect 1 allAck [{ stopped with held := true }] = [{ stopped with held := true }] := by decide
example : collect 1 allAck [{ stopped with terminal := false }] = [{ stopped with terminal := false }] := by decide
example : collect 1 allAck [stopped, stopped] = [] := by decide
example : collect 1 allAck (collect 1 allAck [earned, stopped]) = [earned] := by decide

def active : State := ⟨1, [], [], [stopped, earned], 1, [], some 0⟩
example : (collected allAck active).cold = [earned] := by decide
example : issue stopped.start 900 1000 (collected allAck active) = none := by decide
example : (collected allAck { active with cold := [stopped] }).generation = 1 := by decide

def proof : Proof := ⟨7, 90, 0⟩
def retained : Client := ⟨some proof, false, false⟩
example : prepare retained = some { retained with pending := true } := by decide
example : prepare { retained with payloadPresent := true } = none := by decide
example : prepare ⟨none, false, false⟩ = none := by decide
example : adopt true retained = none := by decide
example : adopt true { retained with pending := true } = some ⟨none, false, false⟩ := by decide
example : adopt false { retained with pending := true } = none := by decide
example : retryWithoutRow 1 true proof = true := by decide
example : retryWithoutRow 0 true proof = false := by decide
example : retryWithoutRow 1 false proof = false := by decide

-- Broken collection deletes the spent row without advancing its generation.
-- Its old authorization can issue another ticket as soon as uniqueness memory
-- is removed. The correct collector above keeps this same-generation row.
def broken : State := ⟨0, [stopped.start], [stopped], [], 0, [], none⟩
example : issue stopped.start 900 1000 { broken with hot := [] } ≠ none := by decide
example : issue stopped.start 900 1000 (collected allAck broken) = none := by decide

end Tests.RecoveryRelease
