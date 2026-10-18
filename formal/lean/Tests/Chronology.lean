import ConvergeAudit.Chronology

open ConvergeAudit.Chronology

namespace Tests.Chronology

def schedule : Schedule Nat := { releaseAt := 10, seed := 777 }
def locked : Slot Nat Nat := .locked 11 9
def opened : Slot Nat Nat := .revealed 11 9 10 777
def spent : Slot Nat Nat := .consumed 11 9 10 777

-- Trusted receipt time, not a timestamp supplied inside the player's log.
example : commit schedule 9 11 .fresh = some locked := by decide
example : commit schedule 10 11 .fresh = none := by decide
example : commit schedule 11 11 .fresh = none := by decide

-- Retrying the same commitment retains its original receipt and changes no choice.
example : commit schedule 12 11 locked = some locked := by decide
example : commit schedule 9 12 locked = none := by decide

-- Release requires a prior commitment and the scheduled external time.
example : release schedule 9 locked = none := by decide
example : release schedule 10 locked = some opened := by decide
example : release schedule 10 (.fresh : Slot Nat Nat) = none := by decide
example : release schedule 20 (.locked 11 10) = none := by decide
example : release schedule 20 opened = none := by decide

-- A choice cannot be replaced after learning this slot's challenge.
example : commit schedule 11 12 opened = none := by decide
example : commit schedule 11 11 opened = none := by decide
example : redeem 12 opened = none := by decide
example : redeem 11 locked = none := by decide
example : redeem 11 opened = some spent := by decide
example : redeem 11 spent = none := by decide

-- Aborting does not restore eligibility, even after seeing a bad challenge.
example : forfeit (.fresh : Slot Nat Nat) = some (.forfeited none) := by decide
example : forfeit opened = some (.forfeited (some 11)) := by decide
example : commit schedule 9 12 (.forfeited (some 11)) = none := by decide
example : release schedule 11 (.forfeited (some 11)) = none := by decide
example : redeem 11 (.forfeited (some 11) : Slot Nat Nat) = none := by decide
example : forfeit spent = none := by decide

-- No successful commitment fits an empty pre-release time interval.
example : commit { releaseAt := 0, seed := 777 } 0 11 .fresh = none := by decide

-- IMPORTANT: copying the authority ledger itself would allow two initial choices.
-- The model requires ONE durable, serialized ledger for this exact ticket/slot.
example : commit schedule 9 11 .fresh = some (.locked 11 9) ∧
    commit schedule 9 12 .fresh = some (.locked 12 9) := by decide

-- Connect the executable operations to one serialized history, not just examples
-- of each operation in isolation.
theorem committedHistory : Follows schedule .fresh locked :=
  .next (.refl .fresh) (.commit 9 11) (by decide)

theorem revealedHistory : Follows schedule .fresh opened :=
  .next committedHistory (.release 10) (by decide)

theorem completed : Follows schedule .fresh spent :=
  .next revealedHistory (.redeem 11) (by decide)

example : WellTimed schedule spent := reachable_well_timed schedule completed

example {later : Slot Nat Nat} (history : Follows schedule locked later)
    (pin : pinned later = some 12) : False := by
  have incompatible := cannot_change_committed_root schedule 11 12 9 history pin
  contradiction

example {later : Slot Nat Nat} (history : Follows schedule spent later) :
    redeem 12 later = none :=
  redeem_cannot_repeat schedule 11 12 (before := opened) (by decide) history

example {later : Slot Nat Nat}
    (history : Follows schedule (.forfeited (some 11)) later) :
    later = .forfeited (some 11) :=
  follows_terminal schedule (fun event => forfeited_terminal schedule event (some 11)) history

end Tests.Chronology
