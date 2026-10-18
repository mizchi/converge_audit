import Std

namespace ConvergeAudit.Reservation

/-- Limits exclude control headroom. The host serializes all pool and scope
updates in one transaction; neither cryptographic authentication nor physical
disk allocation follows from these arithmetic invariants. -/
structure Pool where
  usedBytes : Nat
  usedItems : Nat
  reservedBytes : Nat
  reservedItems : Nat
  maxBytes : Nat
  maxItems : Nat
  deriving DecidableEq, Repr

structure Credit where
  totalBytes : Nat
  totalItems : Nat
  remainingBytes : Nat
  remainingItems : Nat
  spentItems : Nat
  deriving DecidableEq, Repr

def Fits (p : Pool) : Prop :=
  p.usedBytes + p.reservedBytes ≤ p.maxBytes ∧
  p.usedItems + p.reservedItems ≤ p.maxItems
instance (p : Pool) : Decidable (Fits p) := by unfold Fits; infer_instance

def WellFormed (c : Credit) : Prop :=
  0 < c.totalBytes ∧ 0 < c.totalItems ∧ c.remainingBytes ≤ c.totalBytes ∧
  c.remainingItems + c.spentItems = c.totalItems ∧
  (c.remainingItems = 0 → c.remainingBytes = 0)
instance (c : Credit) : Decidable (WellFormed c) := by unfold WellFormed; infer_instance

def reserve (p : Pool) (bytes items : Nat) : Option (Pool × Credit) :=
  if 0 < bytes ∧ 0 < items ∧ p.usedBytes + p.reservedBytes + bytes ≤ p.maxBytes ∧
      p.usedItems + p.reservedItems + items ≤ p.maxItems then
    some ({ p with reservedBytes := p.reservedBytes + bytes, reservedItems := p.reservedItems + items },
      ⟨bytes, items, bytes, items, 0⟩)
  else none

/-- Ownership means this scope's remaining credit is included in the global
counters. The last item releases unused byte credit. No prune refunds items. -/
def consume (p : Pool) (c : Credit) (bytes : Nat) : Option (Pool × Credit) :=
  if 0 < bytes ∧ 0 < c.remainingItems ∧ bytes ≤ c.remainingBytes ∧
      c.remainingBytes ≤ p.reservedBytes ∧ c.remainingItems ≤ p.reservedItems then
    let released := if c.remainingItems = 1 then c.remainingBytes else bytes
    some ({ p with
      usedBytes := p.usedBytes + bytes
      usedItems := p.usedItems + 1
      reservedBytes := p.reservedBytes - released
      reservedItems := p.reservedItems - 1 },
      { c with
        remainingBytes := c.remainingBytes - released
        remainingItems := c.remainingItems - 1
        spentItems := c.spentItems + 1 })
  else none

def prune (p : Pool) (bytes items : Nat) : Pool :=
  { p with usedBytes := p.usedBytes - bytes, usedItems := p.usedItems - items }

/-- The host looks up the same stable scope ID. Reopen never calls reserve. -/
def reopen (c : Credit) (bytes items : Nat) : Option Credit :=
  if c.totalBytes = bytes ∧ c.totalItems = items then some c else none

theorem reservation_preserves_fit (p next : Pool) (c : Credit) (bytes items : Nat)
    (accepted : reserve p bytes items = some (next, c)) : Fits next := by
  unfold reserve at accepted
  split at accepted
  next allowed => cases accepted; simp only [Fits]; omega
  next => contradiction

theorem reservation_credit_well_formed (p next : Pool) (c : Credit) (bytes items : Nat)
    (accepted : reserve p bytes items = some (next, c)) : WellFormed c := by
  unfold reserve at accepted
  split at accepted
  next allowed => cases accepted; simp only [WellFormed]; omega
  next => contradiction

theorem reservation_does_not_write_payload (p next : Pool) (c : Credit) (bytes items : Nat)
    (accepted : reserve p bytes items = some (next, c)) :
    next.usedBytes = p.usedBytes ∧ next.usedItems = p.usedItems := by
  unfold reserve at accepted
  split at accepted
  next => cases accepted; exact ⟨rfl, rfl⟩
  next => contradiction

theorem consumption_preserves_fit (p next : Pool) (c after : Credit) (bytes : Nat)
    (fits : Fits p) (accepted : consume p c bytes = some (next, after)) : Fits next := by
  unfold consume at accepted
  split at accepted
  next allowed =>
    split at accepted <;> cases accepted <;> simp only [Fits] at * <;> omega
  next => contradiction

theorem consumption_preserves_credit (p next : Pool) (c after : Credit) (bytes : Nat)
    (valid : WellFormed c) (accepted : consume p c bytes = some (next, after)) : WellFormed after := by
  unfold consume at accepted
  split at accepted
  next allowed =>
    split at accepted <;> cases accepted <;> simp only [WellFormed] at * <;> omega
  next => contradiction

theorem consumption_spends_exactly_one (p next : Pool) (c after : Credit) (bytes : Nat)
    (accepted : consume p c bytes = some (next, after)) :
    after.spentItems = c.spentItems + 1 ∧ after.remainingItems + 1 = c.remainingItems := by
  unfold consume at accepted
  split at accepted
  next allowed => cases accepted; constructor <;> dsimp <;> omega
  next => contradiction

theorem consumption_never_increases_promised_bytes (p next : Pool) (c after : Credit) (bytes : Nat)
    (accepted : consume p c bytes = some (next, after)) :
    next.usedBytes + next.reservedBytes ≤ p.usedBytes + p.reservedBytes := by
  unfold consume at accepted
  split at accepted
  next allowed => split at accepted <;> cases accepted <;> simp only <;> omega
  next => contradiction

theorem consumption_preserves_other_reservations (p next : Pool) (c after : Credit)
    (bytes otherBytes otherItems : Nat)
    (ownsBytes : p.reservedBytes = c.remainingBytes + otherBytes)
    (ownsItems : p.reservedItems = c.remainingItems + otherItems)
    (accepted : consume p c bytes = some (next, after)) :
    next.reservedBytes = after.remainingBytes + otherBytes ∧
    next.reservedItems = after.remainingItems + otherItems := by
  unfold consume at accepted
  split at accepted
  next allowed => split at accepted <;> cases accepted <;> dsimp <;> omega
  next => contradiction

theorem last_item_returns_unused_credit (p next : Pool) (c after : Credit) (bytes : Nat)
    (last : c.remainingItems = 1) (accepted : consume p c bytes = some (next, after)) :
    after.remainingBytes = 0 ∧ after.remainingItems = 0 := by
  unfold consume at accepted
  split at accepted
  next => simp only [last, Nat.sub_self] at accepted; cases accepted; exact ⟨rfl, rfl⟩
  next => contradiction

theorem exhausted_credit_refuses_consumption (p : Pool) (c : Credit) (bytes : Nat)
    (exhausted : c.remainingItems = 0) : consume p c bytes = none := by
  simp [consume, exhausted]

theorem valid_credit_bounds_total_consumptions (c : Credit) (valid : WellFormed c) :
    c.spentItems ≤ c.totalItems := by
  obtain ⟨_, _, _, accounting, _⟩ := valid
  omega

theorem prune_preserves_fit (p : Pool) (bytes items : Nat) (fits : Fits p) : Fits (prune p bytes items) := by
  simp only [Fits, prune] at *
  omega

theorem prune_does_not_refund_credit (p : Pool) (bytes items : Nat) :
    (prune p bytes items).reservedBytes = p.reservedBytes ∧
    (prune p bytes items).reservedItems = p.reservedItems := ⟨rfl, rfl⟩

theorem reopened_credit_is_unchanged (c after : Credit) (bytes items : Nat)
    (accepted : reopen c bytes items = some after) : after = c := by
  unfold reopen at accepted
  split at accepted
  next => simpa using accepted.symm
  next => contradiction

theorem same_configuration_reopens_spent_credit (c : Credit) :
    reopen c c.totalBytes c.totalItems = some c := by simp [reopen]

/-- Arbitrarily long successful recording histories, including unrelated
payload pruning between writes, cannot spend one scope's item credit twice. -/
inductive Writes : Pool → Credit → List Nat → Pool → Credit → Prop where
  | nil (p : Pool) (c : Credit) : Writes p c [] p c
  | write {p middle next : Pool} {c intermediate after : Credit} {bytes : Nat} {rest : List Nat}
      (accepted : consume p c bytes = some (middle, intermediate))
      (tail : Writes middle intermediate rest next after) : Writes p c (bytes :: rest) next after
  | prune {p next : Pool} {c after : Credit} {bytes items : Nat} {rest : List Nat}
      (tail : Writes (prune p bytes items) c rest next after) : Writes p c rest next after

theorem history_spends_once {p next : Pool} {c after : Credit} {chunks : List Nat}
    (history : Writes p c chunks next after) :
    after.remainingItems + chunks.length = c.remainingItems := by
  induction history with
  | nil => simp
  | write accepted _ ih =>
    have spent := consumption_spends_exactly_one _ _ _ _ _ accepted
    simp only [List.length_cons]
    omega
  | prune _ ih => exact ih

theorem history_count_bounded {p next : Pool} {c after : Credit} {chunks : List Nat}
    (valid : WellFormed c) (history : Writes p c chunks next after) : chunks.length ≤ c.totalItems := by
  have count := history_spends_once history
  obtain ⟨_, _, _, accounting, _⟩ := valid
  omega

theorem history_preserves_fit {p next : Pool} {c after : Credit} {chunks : List Nat}
    (history : Writes p c chunks next after) (fits : Fits p) : Fits next := by
  induction history with
  | nil => exact fits
  | write accepted _ ih => exact ih (consumption_preserves_fit _ _ _ _ _ fits accepted)
  | prune _ ih => exact ih (prune_preserves_fit _ _ _ fits)

/-- Called only after authenticating irreversible whole-scope closure and
comparing the local revision. Payload and UNUSED credit disappear together.
The spent-start ledger and terminal certificate are separate, retained data. -/
def releaseClosed (p : Pool) (c : Credit) (bytes items : Nat) : Pool :=
  { p with
    usedBytes := p.usedBytes - bytes
    usedItems := p.usedItems - items
    reservedBytes := p.reservedBytes - c.remainingBytes
    reservedItems := p.reservedItems - c.remainingItems }

theorem closed_release_preserves_fit (p : Pool) (c : Credit) (bytes items : Nat)
    (fits : Fits p) : Fits (releaseClosed p c bytes items) := by
  simp only [Fits, releaseClosed] at *
  omega

theorem closed_release_keeps_other_reservations (p : Pool) (c : Credit) (bytes items otherBytes otherItems : Nat)
    (ownsBytes : p.reservedBytes = c.remainingBytes + otherBytes)
    (ownsItems : p.reservedItems = c.remainingItems + otherItems) :
    (releaseClosed p c bytes items).reservedBytes = otherBytes ∧
    (releaseClosed p c bytes items).reservedItems = otherItems := by
  simp only [releaseClosed]
  omega

theorem closed_release_keeps_other_payload (p : Pool) (c : Credit) (bytes items otherBytes otherItems : Nat)
    (ownsBytes : p.usedBytes = bytes + otherBytes) (ownsItems : p.usedItems = items + otherItems) :
    (releaseClosed p c bytes items).usedBytes = otherBytes ∧
    (releaseClosed p c bytes items).usedItems = otherItems := by
  simp only [releaseClosed]
  omega

end ConvergeAudit.Reservation
