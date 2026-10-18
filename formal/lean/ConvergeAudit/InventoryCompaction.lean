import Std
namespace ConvergeAudit.InventoryCompaction

/-- A safe wire counter across generations, independent of hot epoch capacity. -/
def maxInventoryReceipts : Nat := 9007199254740991

/-- Symbolic authenticated receipt identities. The runtime binds these fields
with authority signatures, and represents exact heads/batches by SHA-256. This
model proves state transitions, not cryptographic collision resistance. -/
structure Receipt where
  id : Nat
  ticket : Nat
  owner : Nat
  unit : Nat
  asset : Option Nat
  deriving DecidableEq, Repr
abbrev Ledger := Nat → Option Receipt
structure Request where
  previous : Nat
  batch : List Receipt
  deriving DecidableEq, Repr
structure Server where
  owner : Nat
  unit : Nat
  revision : Nat
  receipts : List Receipt
  lastRequest : Option Request
  held : Nat → Bool

def Authorized (ledger : Ledger) (owner unit : Nat) (r : Receipt) : Prop :=
  ledger r.ticket = some r ∧ r.owner = owner ∧ r.unit = unit
instance (ledger : Ledger) (owner unit : Nat) (r : Receipt) : Decidable (Authorized ledger owner unit r) := by
  unfold Authorized; infer_instance
def LastSound (s : Server) : Prop := ∀ q, s.lastRequest = some q → ∀ r ∈ q.batch, r ∈ s.receipts
def Sound (ledger : Ledger) (s : Server) : Prop :=
  (∀ r ∈ s.receipts, Authorized ledger s.owner s.unit r) ∧ (s.receipts.map Receipt.id).Nodup ∧ LastSound s
def FreshAllowed (ledger : Ledger) (q : Request) (s : Server) : Prop :=
  q.previous = s.revision ∧ 0 < q.batch.length ∧ q.batch.length ≤ 16 ∧
  (∀ r ∈ q.batch, Authorized ledger s.owner s.unit r) ∧ (q.batch.map Receipt.id).Nodup ∧
  (∀ r ∈ q.batch, ∀ old ∈ s.receipts, r.id ≠ old.id) ∧ s.receipts.length + q.batch.length ≤ maxInventoryReceipts
instance (ledger : Ledger) (q : Request) (s : Server) : Decidable (FreshAllowed ledger q s) := by
  unfold FreshAllowed; infer_instance
def compact (ledger : Ledger) (q : Request) (s : Server) : Option Server :=
  if s.lastRequest = some q then some s
  else if FreshAllowed ledger q s then
    some { s with revision := s.revision + 1, receipts := s.receipts ++ q.batch, lastRequest := some q }
  else none

theorem identical_retry_is_idempotent (ledger : Ledger) (q : Request) (s : Server)
    (same : s.lastRequest = some q) : compact ledger q s = some s := by simp [compact, same]

theorem stale_nonretry_is_refused (ledger : Ledger) (q : Request) (s : Server)
    (different : s.lastRequest ≠ some q) (stale : q.previous ≠ s.revision) : compact ledger q s = none := by
  simp [compact, different, FreshAllowed, stale]

theorem compact_preserves_scope_and_holds (ledger : Ledger) (q : Request) (s t : Server)
    (accepted : compact ledger q s = some t) : t.owner = s.owner ∧ t.unit = s.unit ∧ t.held = s.held := by
  unfold compact at accepted
  split at accepted
  next => cases accepted; exact ⟨rfl, rfl, rfl⟩
  next =>
    split at accepted
    next => cases accepted; exact ⟨rfl, rfl, rfl⟩
    next => contradiction

theorem compact_preserves_old_receipts (ledger : Ledger) (q : Request) (s t : Server)
    (accepted : compact ledger q s = some t) (r : Receipt) (old : r ∈ s.receipts) : r ∈ t.receipts := by
  unfold compact at accepted
  split at accepted
  next => cases accepted; exact old
  next =>
    split at accepted
    next => cases accepted; exact List.mem_append_left _ old
    next => contradiction

theorem fresh_count_is_incremental (ledger : Ledger) (q : Request) (s t : Server)
    (fresh : s.lastRequest ≠ some q) (accepted : compact ledger q s = some t) :
    t.receipts.length = s.receipts.length + q.batch.length ∧ t.revision = s.revision + 1 ∧ q.batch.length ≤ 16 := by
  simp only [compact, fresh, ↓reduceIte] at accepted
  split at accepted
  next allowed => cases accepted; exact ⟨List.length_append, rfl, allowed.2.2.1⟩
  next => contradiction

theorem compact_preserves_sound (ledger : Ledger) (q : Request) (s t : Server)
    (sound : Sound ledger s) (accepted : compact ledger q s = some t) : Sound ledger t := by
  unfold compact at accepted
  split at accepted
  next => cases accepted; exact sound
  next =>
    split at accepted
    next allowed =>
      cases accepted
      refine ⟨?_, ?_, ?_⟩
      · intro r member
        cases List.mem_append.mp member with
        | inl old => exact sound.1 r old
        | inr added => exact allowed.2.2.2.1 r added
      · simp only [List.map_append, List.nodup_append]
        refine ⟨sound.2.1, allowed.2.2.2.2.1, ?_⟩
        intro a old b added equal
        obtain ⟨oldReceipt, oldMember, oldId⟩ := List.mem_map.mp old
        obtain ⟨newReceipt, newMember, newId⟩ := List.mem_map.mp added
        exact allowed.2.2.2.2.2.1 newReceipt newMember oldReceipt oldMember (newId.trans (equal.symm.trans oldId.symm))
      · intro request same r member
        have identical : q = request := Option.some.inj same
        subst request
        exact List.mem_append_right _ member
    next => contradiction

theorem server_bound_is_preserved (ledger : Ledger) (q : Request) (s t : Server)
    (bounded : s.receipts.length ≤ maxInventoryReceipts) (accepted : compact ledger q s = some t) : t.receipts.length ≤ maxInventoryReceipts := by
  unfold compact at accepted
  split at accepted
  next => cases accepted; exact bounded
  next =>
    split at accepted
    next allowed => cases accepted; simpa only [List.length_append] using allowed.2.2.2.2.2.2
    next => contradiction

theorem duplicate_identity_is_refused (ledger : Ledger) (q : Request) (s : Server)
    (different : s.lastRequest ≠ some q) (duplicate : ¬ (q.batch.map Receipt.id).Nodup) : compact ledger q s = none := by
  simp [compact, different, FreshAllowed, duplicate]

theorem already_indexed_identity_is_refused (ledger : Ledger) (q : Request) (s : Server)
    (different : s.lastRequest ≠ some q) (r old : Receipt) (newMember : r ∈ q.batch) (oldMember : old ∈ s.receipts)
    (same : r.id = old.id) : compact ledger q s = none := by
  have denied : ¬ FreshAllowed ledger q s := by
    intro allowed
    exact allowed.2.2.2.2.2.1 r newMember old oldMember same
  simp [compact, different, denied]

inductive Follows (ledger : Ledger) : Server → Server → Prop where
  | refl (s) : Follows ledger s s
  | append {s m t} (history : Follows ledger s m) (q) (accepted : compact ledger q m = some t) : Follows ledger s t

theorem history_preserves_sound (ledger : Ledger) (s t : Server) (sound : Sound ledger s)
    (history : Follows ledger s t) : Sound ledger t := by
  induction history with
  | refl => exact sound
  | append _ q accepted ih => exact compact_preserves_sound ledger q _ _ ih accepted

theorem catalog_receipt_has_original_provenance (ledger : Ledger) (s : Server) (sound : Sound ledger s)
    (r : Receipt) (member : r ∈ s.receipts) : ledger r.ticket = some r ∧ r.owner = s.owner ∧ r.unit = s.unit := sound.1 r member

/-- Market always consults the live source/case state. Catalog membership and
an old checkpoint cannot bypass a current evidence hold. -/
def MarketAllowed (ledger : Ledger) (s : Server) (r : Receipt) : Prop :=
  Authorized ledger s.owner s.unit r ∧ s.held r.ticket = false

theorem held_item_is_not_marketable (ledger : Ledger) (s : Server) (r : Receipt)
    (held : s.held r.ticket = true) : ¬ MarketAllowed ledger s r := by
  intro allowed
  have impossible := allowed.2
  rw [held] at impossible
  contradiction

theorem compaction_preserves_market_decision (ledger : Ledger) (q : Request) (s t : Server)
    (accepted : compact ledger q s = some t) (r : Receipt) : MarketAllowed ledger t r ↔ MarketAllowed ledger s r := by
  obtain ⟨owner, unit, holds⟩ := compact_preserves_scope_and_holds ledger q s t accepted
  simp only [MarketAllowed, owner, unit, holds]

/-- Only the count/revision checkpoint and one page remain on the client.
The server retains the indexed original receipts. The runtime's signed root
and digest are fixed-size fields; they do not contain this server list. -/
structure Client where
  revision : Nat
  count : Nat
  window : List Receipt
  page : List Receipt
  pending : Bool
  deriving DecidableEq, Repr
def Bounded (c : Client) : Prop := c.window.length ≤ 16 ∧ c.page.length ≤ 3
def prepare (c : Client) : Option Client :=
  if 0 < c.window.length ∧ c.window.length ≤ 16 then some { c with pending := true } else none
def remember (r : Receipt) (c : Client) : Option Client :=
  if c.pending = false ∧ c.window.length < 16 then some { c with window := c.window ++ [r] } else none
def cachePage (rows : List Receipt) (c : Client) : Option Client :=
  if rows.length ≤ 3 then some { c with page := rows } else none
def adopt (s : Server) (c : Client) : Option Client :=
  if c.pending = true ∧ s.lastRequest = some ⟨c.revision, c.window⟩ ∧
      s.revision = c.revision + 1 ∧ s.receipts.length = c.count + c.window.length then
    some ⟨s.revision, s.receipts.length, [], [], false⟩ else none

theorem prepare_keeps_all_recovery_receipts (c d : Client) (accepted : prepare c = some d) :
    d.window = c.window ∧ d.count = c.count ∧ d.pending = true := by
  unfold prepare at accepted
  split at accepted
  next => cases accepted; exact ⟨rfl, rfl, rfl⟩
  next => contradiction

theorem remember_preserves_bound (r : Receipt) (c d : Client) (bounded : Bounded c)
    (accepted : remember r c = some d) : Bounded d := by
  unfold remember at accepted
  split at accepted
  next allowed => cases accepted; simp only [Bounded, List.length_append, List.length_singleton]; exact ⟨by omega, bounded.2⟩
  next => contradiction

theorem cache_replaces_instead_of_accumulating (rows : List Receipt) (c d : Client)
    (accepted : cachePage rows c = some d) : d.page = rows ∧ d.window = c.window ∧ d.page.length ≤ 3 := by
  unfold cachePage at accepted
  split at accepted
  next allowed => cases accepted; exact ⟨rfl, rfl, allowed⟩
  next => contradiction

theorem adoption_is_bounded_and_preserves_count (s : Server) (c d : Client) (accepted : adopt s c = some d) :
    Bounded d ∧ d.window = [] ∧ d.count = c.count + c.window.length ∧ d.pending = false := by
  unfold adopt at accepted
  split at accepted
  next allowed => cases accepted; exact ⟨⟨by simp, by simp⟩, rfl, allowed.2.2.2, rfl⟩
  next => contradiction

theorem adopted_receipts_remain_available_with_provenance (ledger : Ledger) (s : Server) (sound : Sound ledger s)
    (c d : Client) (accepted : adopt s c = some d) (r : Receipt) (member : r ∈ c.window) :
    r ∈ s.receipts ∧ Authorized ledger s.owner s.unit r := by
  unfold adopt at accepted
  split at accepted
  next allowed =>
    have retained := sound.2.2 ⟨c.revision, c.window⟩ allowed.2.1 r member
    exact ⟨retained, sound.1 r retained⟩
  next => contradiction

end ConvergeAudit.InventoryCompaction
