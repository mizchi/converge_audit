import ConvergeAudit.Recovery
namespace Tests.Recovery
open ConvergeAudit.Recovery
def full : Progress := ⟨0, 2, 2⟩
def half : Progress := ⟨0, 1, 1⟩
example : recover .issued full 3 4 = .ready := by decide
example : recover .issued full 4 4 = .interrupted := by decide
example : recover .issued half 3 4 = .interrupted := by decide
example : recover .committed half 3 4 = .interrupted := by decide
example : recover .revealed ⟨1, 2, 1⟩ 5 4 = .interrupted := by decide
example : recover .committed full 5 4 = .waiting := by decide
example : recover .revealed full 5 4 = .waiting := by decide
example : recover .settled ⟨0, 0, 0⟩ 5 4 = .settled := by decide
example : recover .forfeited full 5 4 = .terminated := by decide
example : mayStep (recover .issued half 3 4) = false := by decide
end Tests.Recovery
