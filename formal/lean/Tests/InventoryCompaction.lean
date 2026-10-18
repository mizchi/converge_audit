import ConvergeAudit.InventoryCompaction
namespace Tests.InventoryCompaction
open ConvergeAudit.InventoryCompaction
def first : Receipt := ⟨1, 11, 7, 8, some 21⟩
def second : Receipt := ⟨2, 12, 7, 8, none⟩
def foreignReceipt : Receipt := ⟨3, 13, 9, 8, some 22⟩
def ledger : Ledger := fun ticket =>
  if ticket = 11 then some first else if ticket = 12 then some second else if ticket = 13 then some foreignReceipt else none
def initial : Server := ⟨7, 8, 0, [], none, fun _ => false⟩
def firstRequest : Request := ⟨0, [first]⟩
example : (compact ledger firstRequest initial).isSome = true := by decide
example : (compact ledger ⟨0, []⟩ initial).isNone = true := by decide
example : (compact ledger ⟨0, [first, first]⟩ initial).isNone = true := by decide
example : (compact ledger ⟨0, [foreignReceipt]⟩ initial).isNone = true := by decide
example : (compact ledger ⟨0, [{ first with id := 99 }]⟩ initial).isNone = true := by decide
example : (compact ledger ⟨0, [first, second]⟩ initial).isSome = true := by decide
example : (compact ledger firstRequest initial).map (fun s => s.receipts.length) = some 1 := by decide
example : ((compact ledger firstRequest initial).bind (compact ledger firstRequest)).map (fun s => s.receipts.length) = some 1 := by decide
example : ((compact ledger firstRequest initial).bind (compact ledger ⟨1, [first]⟩)).isNone = true := by decide
example : ((compact ledger firstRequest initial).bind (compact ledger ⟨0, [second]⟩)).isNone = true := by decide
example : remember first ⟨0, 0, List.replicate 16 first, [], false⟩ = none := by decide
example : (cachePage [first, second] ⟨0, 0, [], [], false⟩).isSome = true := by decide
example : cachePage (List.replicate 4 first) ⟨0, 0, [], [], false⟩ = none := by decide
example : adopt initial ⟨0, 0, [first], [], false⟩ = none := by decide
example : ((compact ledger firstRequest initial).bind (fun s => adopt s ⟨0, 0, [first], [], true⟩)).map Client.count = some 1 := by decide
example : ((compact ledger firstRequest initial).bind (fun s => adopt s ⟨0, 0, [first], [], false⟩)).isNone = true := by decide
example : (compact ledger firstRequest { initial with held := fun _ => true }).map (fun s => s.held 11) = some true := by decide
example : remember second ⟨0, 0, [first], [], true⟩ = none := by decide
example : (cachePage [second] ⟨0, 0, [], [first], false⟩).map Client.page = some [second] := by decide
end Tests.InventoryCompaction
