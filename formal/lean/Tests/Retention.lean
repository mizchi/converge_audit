import ConvergeAudit.Retention

open ConvergeAudit.Retention

namespace Tests.Retention

def budget : Budget := { maxBytes := 12, reservedBytes := 2, maxItems := 2, maxItemBytes := 8 }
def pending : Chunk := { bytes := 5 }
def delivered : Chunk := { bytes := 5, acknowledged := true }
def safe : Chunk := { bytes := 5, acknowledged := true, finalized := true, retentionClosed := true }
def held : Chunk := { safe with held := true }

example : admit budget pending [] = some [pending] := by decide
example : admit budget pending [pending] = some [pending, pending] := by decide
example : admit budget pending [pending, pending] = none := by decide
example : admit budget { pending with bytes := 9 } [] = none := by decide
example : admit budget { pending with bytes := 0 } [] = none := by decide
example : admit budget { pending with bytes := 6 } [pending] = none := by decide
example : prunable delivered = false := by decide
example : prunable held = false := by decide
example : prunable { safe with retentionClosed := false } = false := by decide
example : prunePrefix [safe, held, safe] = ([safe], [held, safe]) := by decide
example : prunePrefix [delivered, safe] = ([], [delivered, safe]) := by decide
example : Fits budget [pending, pending] := by decide
example : ¬ Fits budget [pending, pending, pending] := by decide

example : Fits budget (prunePrefix [safe, held]).2 :=
  prune_preserves_fit budget [safe, held] (by decide)

example : held ∈ (prunePrefix [safe, held, safe]).2 :=
  protected_chunk_retained [safe, held, safe] held (by simp) (by decide)

end Tests.Retention
