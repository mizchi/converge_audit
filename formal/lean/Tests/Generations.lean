import ConvergeAudit.Generations
namespace Tests.Generations
open ConvergeAudit.Generations
def start : Start := ⟨0, 7⟩
def record : Record := ⟨start, 11, some 21, true, true, false, some 99⟩
def initial : State := ⟨0, [start], [record], [], 0, [⟨start, false⟩], none⟩
example : (roll 0 initial).isSome = true := by decide
example : (roll 1 initial).isNone = true := by decide
example : (roll 0 { initial with hot := [{ record with held := true }] }).isNone = true := by decide
example : (roll 0 { initial with hot := [{ record with retired := false }] }).isNone = true := by decide
example : (roll 0 { initial with hot := [{ record with terminal := false }] }).isNone = true := by decide
example : (roll 0 { initial with archives := [⟨start, true⟩] }).isNone = true := by decide
example : (roll 0 { initial with admissions := [start, ⟨0, 8⟩] }).isNone = true := by decide
example : (roll 0 initial).map State.generation = some 1 := by decide
example : (roll 0 initial).map (fun s => s.cold.map source) = some [source record] := by decide
example : (roll 0 initial).map (fun s => s.cold.map Record.secret) = some [none] := by decide
example : ((roll 0 initial).bind (issue start 12 42)).isNone = true := by decide
example : ((roll 0 initial).bind (registerArchive ⟨start, true⟩)).isNone = true := by decide
example : ((roll 0 initial).bind (roll 0)).map State.generation = some 1 := by decide
example : ((roll 0 initial).bind (allocate ⟨1, 7⟩)).isSome = true := by decide
example : ((roll 0 initial).bind (allocate ⟨1, 7⟩) |>.bind (issue ⟨1, 7⟩ 12 42)).isSome = true := by decide
example : ((roll 0 initial).bind (allocate ⟨1, 7⟩) |>.bind (issue ⟨1, 7⟩ 12 42) |>.bind (issue ⟨1, 7⟩ 13 43)).isNone = true := by decide
example : (roll 0 initial).map (fun s => s.archives.length) = some 0 := by decide
example : roll 9007199254740991 { initial with generation := 9007199254740991 } = none := by decide
/-- Broken control: deleting spent heads without advancing the generation lets
the same authorization be allocated and issued again under a new ticket ID. -/
def brokenReset : State := { initial with admissions := [], hot := [], archives := [], cold := [stripSecret record] }
example : ((allocate start brokenReset).bind (issue start 12 42)).isSome = true := by decide
example : ((roll 0 initial).bind (allocate start)).isNone = true := by decide
end Tests.Generations
