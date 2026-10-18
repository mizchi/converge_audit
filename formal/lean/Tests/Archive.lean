import ConvergeAudit.Archive
namespace Tests.Archive
open ConvergeAudit.Archive
def scope : Manifest := ⟨1, 2, 3, 10⟩
def initial : State := ⟨scope, true, none, none, false, true⟩
example : handoff initial = none := by decide
example : ((persist scope initial).bind acknowledge).isSome = true := by decide
example : (((persist scope initial).bind acknowledge).bind handoff).isSome = true := by decide
example : (((persist scope initial).bind acknowledge).bind handoff).bind (release 20) = none := by decide
example : (persist ⟨1, 2, 4, 10⟩ initial) = none := by decide
def remote : State := ⟨scope, false, some scope, some scope, true, false⟩
example : release 9 remote = none := by decide
example : (release 10 remote).isSome = true := by decide
example : Available initial := by decide
example : Safe initial := by simp [Safe, Available, CustodySound, initial]
example : Available { remote with closed := false } := by decide
example : acknowledge initial = none := by decide
example : setHold true remote = none := by decide
def cases : ConvergeAudit.Cases.Registry 1 := ⟨fun _ => some ⟨7, none, false⟩, false, false, 1⟩
example : release 20 (withCases cases remote) = none := by decide
end Tests.Archive
