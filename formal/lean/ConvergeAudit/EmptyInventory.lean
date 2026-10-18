import Std

namespace ConvergeAudit.EmptyInventory

/-- Symbolic authenticated origins. Only `none` slots lose their identity in
 * storage; even a retained empty receipt is represented by `some receipt`. -/
structure Receipt where
  id : Nat
  asset : Option Nat
  oldGeneration : Bool
  retentionClosed : Bool
  held : Bool
  deriving DecidableEq, Repr
abbrev Slot := Option Receipt
def mayRetire (r : Receipt) : Bool := r.asset.isNone && r.oldGeneration && r.retentionClosed && !r.held
def eraseOne (chosen : List Nat) : Slot → Slot
  | none => none
  | some r => if r.id ∈ chosen ∧ mayRetire r = true then none else some r
def retireRows (chosen : List Nat) (rows : List Slot) : List Slot := rows.map (eraseOne chosen)
def assets (rows : List Slot) : List Nat := rows.filterMap (fun slot => slot.bind Receipt.asset)

theorem retired_source_requires_all_guards (chosen : List Nat) (r : Receipt)
    (removed : eraseOne chosen (some r) = none) :
    r.id ∈ chosen ∧ r.asset = none ∧ r.oldGeneration = true ∧ r.retentionClosed = true ∧ r.held = false := by
  simp only [eraseOne] at removed
  split at removed
  next allowed =>
    refine ⟨allowed.1, ?_⟩
    have guards := allowed.2
    simp only [mayRetire, Bool.and_eq_true] at guards
    have clear : r.held = false := by
      cases held : r.held with
      | false => rfl
      | true => have denied := guards.2; rw [held] at denied; contradiction
    exact ⟨Option.isNone_iff_eq_none.mp guards.1.1.1, guards.1.1.2, guards.1.2, clear⟩
  next => contradiction

theorem item_receipt_survives (chosen : List Nat) (r : Receipt) (item : r.asset ≠ none) :
    eraseOne chosen (some r) = some r := by
  cases asset : r.asset with
  | none => exact False.elim (item asset)
  | some a => simp [eraseOne, mayRetire, asset]

theorem held_receipt_survives (chosen : List Nat) (r : Receipt) (held : r.held = true) :
    eraseOne chosen (some r) = some r := by simp [eraseOne, mayRetire, held]

theorem current_receipt_survives (chosen : List Nat) (r : Receipt) (current : r.oldGeneration = false) :
    eraseOne chosen (some r) = some r := by simp [eraseOne, mayRetire, current]

theorem retained_receipt_survives (chosen : List Nat) (r : Receipt) (retained : r.retentionClosed = false) :
    eraseOne chosen (some r) = some r := by simp [eraseOne, mayRetire, retained]

theorem retirement_keeps_historical_count (chosen : List Nat) (rows : List Slot) :
    (retireRows chosen rows).length = rows.length := by simp [retireRows]

theorem one_retirement_preserves_asset (chosen : List Nat) (slot : Slot) :
    (eraseOne chosen slot).bind Receipt.asset = slot.bind Receipt.asset := by
  cases slot with
  | none => rfl
  | some r =>
    by_cases empty : r.asset = none
    · simp [eraseOne]; split <;> simp_all
    · rw [item_receipt_survives chosen r empty]

theorem retirement_preserves_all_assets (chosen : List Nat) (rows : List Slot) :
    assets (retireRows chosen rows) = assets rows := by
  simp [assets, retireRows, List.filterMap_map, Function.comp_def, one_retirement_preserves_asset]

inductive Segment where
  | saved (receipt : Receipt)
  | empty (length : Nat)
  deriving DecidableEq, Repr
def prependEmpty : List Segment → List Segment
  | .empty n :: rest => .empty (n + 1) :: rest
  | rest => .empty 1 :: rest
def pack : List Slot → List Segment
  | [] => []
  | none :: rest => prependEmpty (pack rest)
  | some r :: rest => .saved r :: pack rest
def expand (segments : List Segment) : List Slot := segments.flatMap fun s =>
  match s with
  | .saved r => [some r]
  | .empty n => List.replicate n none

theorem prepend_empty_preserves_slots (segments : List Segment) :
    expand (prependEmpty segments) = none :: expand segments := by
  cases segments with
  | nil => rfl
  | cons s rest => cases s <;> simp [prependEmpty, expand, List.replicate_succ]

theorem compression_round_trip (rows : List Slot) : expand (pack rows) = rows := by
  induction rows with
  | nil => rfl
  | cons slot rest ih =>
    cases slot with
    | none => change expand (prependEmpty (pack rest)) = none :: rest; rw [prepend_empty_preserves_slots, ih]
    | some r => change some r :: expand (pack rest) = some r :: rest; rw [ih]

theorem compressed_retirement_preserves_count (chosen : List Nat) (rows : List Slot) :
    (expand (pack (retireRows chosen rows))).length = rows.length := by
  rw [compression_round_trip, retirement_keeps_historical_count]

theorem compressed_retirement_preserves_assets (chosen : List Nat) (rows : List Slot) :
    assets (expand (pack (retireRows chosen rows))) = assets rows := by
  rw [compression_round_trip, retirement_preserves_all_assets]

theorem compression_is_canonical_after_expansion (rows : List Slot) :
    pack (expand (pack rows)) = pack rows := by rw [compression_round_trip]

theorem prepend_empty_adds_at_most_one_row (segments : List Segment) :
    (prependEmpty segments).length ≤ segments.length + 1 := by
  cases segments with
  | nil => decide
  | cons s rest => cases s <;> simp [prependEmpty]

theorem compression_never_grows (rows : List Slot) : (pack rows).length ≤ rows.length := by
  induction rows with
  | nil => decide
  | cons slot rest ih =>
    cases slot with
    | none => have bound := prepend_empty_adds_at_most_one_row (pack rest); simp only [pack, List.length_cons]; omega
    | some r => simp only [pack, List.length_cons]; omega

theorem empty_run_is_one_row (n : Nat) : pack (List.replicate (n + 1) none) = [.empty (n + 1)] := by
  induction n with
  | zero => rfl
  | succ n ih =>
    rw [List.replicate_succ]
    change prependEmpty (pack (List.replicate (n + 1) none)) = [.empty (n + 1 + 1)]
    rw [ih]; rfl

/-- The maximum number of empty ranges is bounded by retained receipts, not
 * the number of retired games. An empty run contributes only at its start. -/
def retainedCount : List Slot → Nat
  | [] => 0
  | none :: rest => retainedCount rest
  | some _ :: rest => retainedCount rest + 1
def emptyRuns (inGap : Bool) : List Slot → Nat
  | [] => 0
  | none :: rest => (if inGap then 0 else 1) + emptyRuns true rest
  | some _ :: rest => emptyRuns false rest

theorem empty_ranges_are_bounded_by_retained_receipts (rows : List Slot) (inGap : Bool) :
    emptyRuns inGap rows ≤ retainedCount rows + (if inGap then 0 else 1) := by
  induction rows generalizing inGap with
  | nil => cases inGap <;> decide
  | cons slot rest ih =>
    cases slot with
    | none => have bound := ih true; cases inGap <;> simp [emptyRuns, retainedCount] at * <;> omega
    | some r => have bound := ih false; cases inGap <;> simp [emptyRuns, retainedCount] at * <;> omega

def gapCount : List Segment → Nat
  | [] => 0
  | .saved _ :: rest => gapCount rest
  | .empty _ :: rest => gapCount rest + 1

theorem extending_gap_does_not_add_rows (segments : List Segment) :
    gapCount (prependEmpty (prependEmpty segments)) = gapCount (prependEmpty segments) := by
  cases segments with
  | nil => rfl
  | cons s rest => cases s <;> rfl

theorem compressed_gap_count_matches_runs (rows : List Slot) : gapCount (pack rows) = emptyRuns false rows := by
  induction rows with
  | nil => rfl
  | cons slot rest ih =>
    cases slot with
    | some r => exact ih
    | none =>
      cases rest with
      | nil => rfl
      | cons next tail =>
        cases next with
        | none =>
          change gapCount (prependEmpty (prependEmpty (pack tail))) = 1 + (0 + emptyRuns true tail)
          rw [extending_gap_does_not_add_rows]
          simpa [pack, emptyRuns] using ih
        | some r =>
          change gapCount (pack tail) = emptyRuns false tail at ih
          change gapCount (pack tail) + 1 = 1 + emptyRuns false tail
          omega

theorem compressed_ranges_are_bounded (rows : List Slot) : gapCount (pack rows) ≤ retainedCount rows + 1 := by
  rw [compressed_gap_count_matches_runs]
  exact empty_ranges_are_bounded_by_retained_receipts rows false

def savedCount : List Segment → Nat
  | [] => 0
  | .saved _ :: rest => savedCount rest + 1
  | .empty _ :: rest => savedCount rest

theorem empty_prefix_preserves_saved_count (segments : List Segment) : savedCount (prependEmpty segments) = savedCount segments := by
  cases segments with
  | nil => rfl
  | cons s rest => cases s <;> rfl

theorem compressed_saved_count (rows : List Slot) : savedCount (pack rows) = retainedCount rows := by
  induction rows with
  | nil => rfl
  | cons slot rest ih =>
    cases slot with
    | none => change savedCount (prependEmpty (pack rest)) = retainedCount rest; rw [empty_prefix_preserves_saved_count, ih]
    | some r => change savedCount (pack rest) + 1 = retainedCount rest + 1; rw [ih]

theorem compressed_row_accounting (segments : List Segment) : segments.length = savedCount segments + gapCount segments := by
  induction segments with
  | nil => rfl
  | cons s rest ih => cases s <;> simp only [List.length_cons, savedCount, gapCount] <;> omega

theorem compressed_storage_bound (rows : List Slot) : (pack rows).length ≤ 2 * retainedCount rows + 1 := by
  rw [compressed_row_accounting, compressed_saved_count]
  have bound := compressed_ranges_are_bounded rows
  omega

structure Request where
  previous : Nat
  tickets : List Nat
  deriving DecidableEq, Repr
structure Head where
  revision : Nat
  receiptCount : Nat
  itemCount : Nat
  retiredCount : Nat
  lastRetirement : Option Request
  deriving DecidableEq, Repr
def freshAllowed (q : Request) (eligible : Bool) (s : Head) : Prop :=
  q.previous = s.revision ∧ eligible = true ∧ 0 < q.tickets.length ∧ q.tickets.length ≤ 16 ∧
  q.tickets.Nodup ∧ s.itemCount + s.retiredCount + q.tickets.length ≤ s.receiptCount
instance (q : Request) (eligible : Bool) (s : Head) : Decidable (freshAllowed q eligible s) := by
  unfold freshAllowed; infer_instance
def retireHead (q : Request) (eligible : Bool) (s : Head) : Option Head :=
  if s.lastRetirement = some q then some s
  else if freshAllowed q eligible s then some { s with
    revision := s.revision + 1
    retiredCount := s.retiredCount + q.tickets.length
    lastRetirement := some q }
  else none

theorem exact_retry_needs_no_deleted_source (q : Request) (s : Head) (same : s.lastRetirement = some q) :
    retireHead q false s = some s := by simp [retireHead, same]

theorem stale_nonretry_is_refused (q : Request) (eligible : Bool) (s : Head)
    (different : s.lastRetirement ≠ some q) (stale : q.previous ≠ s.revision) : retireHead q eligible s = none := by
  simp [retireHead, different, freshAllowed, stale]

theorem retirement_head_preserves_counts (q : Request) (eligible : Bool) (s t : Head)
    (accepted : retireHead q eligible s = some t) : t.receiptCount = s.receiptCount ∧ t.itemCount = s.itemCount := by
  unfold retireHead at accepted
  split at accepted
  next => cases accepted; exact ⟨rfl, rfl⟩
  next =>
    split at accepted
    next => cases accepted; exact ⟨rfl, rfl⟩
    next => contradiction

theorem fresh_retirement_counts_once (q : Request) (eligible : Bool) (s t : Head)
    (fresh : s.lastRetirement ≠ some q) (accepted : retireHead q eligible s = some t) :
    t.retiredCount = s.retiredCount + q.tickets.length ∧ t.revision = s.revision + 1 ∧ q.tickets.length ≤ 16 := by
  simp only [retireHead, fresh, ↓reduceIte] at accepted
  split at accepted
  next allowed => cases accepted; exact ⟨rfl, rfl, allowed.2.2.2.1⟩
  next => contradiction

theorem head_counts_remain_consistent (q : Request) (eligible : Bool) (s t : Head)
    (bound : s.itemCount + s.retiredCount ≤ s.receiptCount) (accepted : retireHead q eligible s = some t) :
    t.itemCount + t.retiredCount ≤ t.receiptCount := by
  unfold retireHead at accepted
  split at accepted
  next => cases accepted; exact bound
  next =>
    split at accepted
    next allowed => cases accepted; have := allowed.2.2.2.2.2; simp_all; omega
    next => contradiction

theorem live_ineligible_sources_cannot_retire (q : Request) (s : Head) (fresh : s.lastRetirement ≠ some q) :
    retireHead q false s = none := by simp [retireHead, fresh, freshAllowed]

end ConvergeAudit.EmptyInventory
