import ConvergeAudit.EmptyInventory
namespace Tests.EmptyInventory
open ConvergeAudit.EmptyInventory
def emptyReceipt : Receipt := ⟨1, none, true, true, false⟩
def itemReceipt : Receipt := ⟨2, some 90, true, true, false⟩

example : eraseOne [1] (some emptyReceipt) = none := by decide
example : eraseOne [] (some emptyReceipt) = some emptyReceipt := by decide
example : eraseOne [2] (some itemReceipt) = some itemReceipt := by decide
example : eraseOne [1] (some { emptyReceipt with held := true }) = some { emptyReceipt with held := true } := by decide
example : eraseOne [1] (some { emptyReceipt with retentionClosed := false }) = some { emptyReceipt with retentionClosed := false } := by decide
example : eraseOne [1] (some { emptyReceipt with oldGeneration := false }) = some { emptyReceipt with oldGeneration := false } := by decide
example : pack [none, none, some itemReceipt, none] = [.empty 2, .saved itemReceipt, .empty 1] := by decide
example : pack [some emptyReceipt] = [.saved emptyReceipt] := by decide
example : expand [.empty 2, .saved itemReceipt] = [none, none, some itemReceipt] := by decide
example : expand (pack [none, some itemReceipt, none]) = [none, some itemReceipt, none] := compression_round_trip _
example : assets (expand (pack (retireRows [1] [some emptyReceipt, some itemReceipt]))) = [90] := by decide
example : (expand (pack (retireRows [1] [some emptyReceipt, some itemReceipt]))).length = 2 := by decide
example : pack (List.replicate 128 none) = [.empty 128] := empty_run_is_one_row 127
example : gapCount (pack [none, some itemReceipt, none, none]) = 2 := by decide
example : gapCount (pack (List.replicate 128 none)) = 1 := by rw [empty_run_is_one_row 127]; rfl

def head : Head := ⟨1, 3, 1, 0, none⟩
def request : Request := ⟨1, [1, 3]⟩
def retired : Head := ⟨2, 3, 1, 2, some request⟩
example : retireHead request true head = some retired := by decide
example : retireHead request false retired = some retired := by decide
example : retireHead request false head = none := by decide
example : retireHead ⟨0, [1]⟩ true head = none := by decide
example : retireHead ⟨1, [1, 1]⟩ true head = none := by decide
example : retireHead ⟨1, []⟩ true head = none := by decide
example : retireHead ⟨1, [1, 3, 4]⟩ true head = none := by decide
example : retireHead request false { retired with revision := 3, lastRetirement := none } = none := by decide

-- Removing empty receipts as list elements destroys the historical ordinal
-- of a retained item. Replacing slots with gaps preserves it instead.
example : [some emptyReceipt, some itemReceipt].length ≠ [some itemReceipt].length := by decide
example : (retireRows [1] [some emptyReceipt, some itemReceipt])[1]? = some (some itemReceipt) := by decide

end Tests.EmptyInventory
