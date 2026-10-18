import Std

namespace ConvergeAudit.Retention

structure Budget where
  maxBytes : Nat
  maxItems : Nat
  maxItemBytes : Nat
  reservedBytes : Nat

/-- Evidence facts are authenticated by a separate retention authority. Their
truth does not follow from client flags, transport ACKs or a local clock. -/
structure Chunk where
  bytes : Nat
  acknowledged : Bool := false
  finalized : Bool := false
  retentionClosed : Bool := false
  held : Bool := false
  deriving DecidableEq, Repr

def usedBytes : List Chunk → Nat
  | [] => 0
  | chunk :: rest => chunk.bytes + usedBytes rest

def Fits (budget : Budget) (chunks : List Chunk) : Prop :=
  budget.reservedBytes ≤ budget.maxBytes ∧
  usedBytes chunks ≤ budget.maxBytes - budget.reservedBytes ∧
  chunks.length ≤ budget.maxItems

instance (budget : Budget) (chunks : List Chunk) : Decidable (Fits budget chunks) := by
  unfold Fits
  infer_instance

def Admissible (budget : Budget) (incoming : Chunk) (chunks : List Chunk) : Prop :=
  budget.reservedBytes ≤ budget.maxBytes ∧
  0 < incoming.bytes ∧ incoming.bytes ≤ budget.maxItemBytes ∧
  chunks.length < budget.maxItems ∧
  usedBytes chunks ≤ budget.maxBytes - budget.reservedBytes ∧
  incoming.bytes ≤ budget.maxBytes - budget.reservedBytes - usedBytes chunks

instance (budget : Budget) (incoming : Chunk) (chunks : List Chunk) :
    Decidable (Admissible budget incoming chunks) := by
  unfold Admissible
  infer_instance

/-- Mathematical contents model. The IndexedDB implementation uses durable
byte/item counters instead of recomputing this list sum for each admission. -/
def admit (budget : Budget) (incoming : Chunk) (chunks : List Chunk) : Option (List Chunk) :=
  if Admissible budget incoming chunks then some (chunks ++ [incoming]) else none

def prunable (chunk : Chunk) : Bool :=
  chunk.acknowledged && chunk.finalized && chunk.retentionClosed && !chunk.held

/-- Drop only the contiguous safe prefix. A blocker also retains its suffix. -/
def prunePrefix : List Chunk → List Chunk × List Chunk
  | [] => ([], [])
  | chunk :: rest =>
      if prunable chunk then
        let result := prunePrefix rest
        (chunk :: result.1, result.2)
      else ([], chunk :: rest)

theorem used_bytes_append (first second : List Chunk) :
    usedBytes (first ++ second) = usedBytes first + usedBytes second := by
  induction first with
  | nil => simp [usedBytes]
  | cons head tail previous => simp [usedBytes, previous, Nat.add_assoc]

theorem admission_iff (budget : Budget) (incoming : Chunk) (chunks next : List Chunk) :
    admit budget incoming chunks = some next ↔
      Admissible budget incoming chunks ∧ next = chunks ++ [incoming] := by
  by_cases allowed : Admissible budget incoming chunks <;>
    simp [admit, allowed, eq_comm]

theorem admitted_queue_fits (budget : Budget) (incoming : Chunk) (chunks next : List Chunk)
    (accepted : admit budget incoming chunks = some next) : Fits budget next := by
  obtain ⟨allowed, rfl⟩ := (admission_iff budget incoming chunks next).mp accepted
  obtain ⟨reserve, _positive, _single, count, bytes, room⟩ := allowed
  simp only [Fits, used_bytes_append, usedBytes, List.length_append, List.length_singleton]
  omega

theorem full_queue_backpressures (budget : Budget) (incoming : Chunk) (chunks : List Chunk)
    (full : budget.maxItems ≤ chunks.length) : admit budget incoming chunks = none := by
  have refused : ¬ Admissible budget incoming chunks := by
    intro allowed
    have count := allowed.2.2.2.1
    omega
  simp [admit, refused]

theorem ack_alone_not_prunable (bytes : Nat) :
    prunable { bytes, acknowledged := true } = false := by rfl

theorem hold_blocks_prune (chunk : Chunk) (held : chunk.held = true) :
    prunable chunk = false := by simp [prunable, held]

theorem prunable_requires_finality (chunk : Chunk) (allowed : prunable chunk = true) :
    chunk.acknowledged = true ∧ chunk.finalized = true ∧
      chunk.retentionClosed = true ∧ chunk.held = false := by
  simpa [prunable, and_assoc] using allowed

theorem prefix_reconstructs (chunks : List Chunk) :
    (prunePrefix chunks).1 ++ (prunePrefix chunks).2 = chunks := by
  induction chunks with
  | nil => rfl
  | cons chunk rest previous =>
      by_cases allowed : prunable chunk = true <;> simp [prunePrefix, allowed, previous]

theorem removed_only_prunable (chunks : List Chunk) (chunk : Chunk)
    (removed : chunk ∈ (prunePrefix chunks).1) : prunable chunk = true := by
  induction chunks with
  | nil => simp [prunePrefix] at removed
  | cons head rest previous =>
      by_cases allowed : prunable head = true
      · simp only [prunePrefix, allowed, ↓reduceIte, List.mem_cons] at removed
        rcases removed with same | later
        · exact same ▸ allowed
        · exact previous later
      · simp [prunePrefix, allowed] at removed

theorem protected_chunk_retained (chunks : List Chunk) (chunk : Chunk)
    (present : chunk ∈ chunks) (blocked : prunable chunk = false) :
    chunk ∈ (prunePrefix chunks).2 := by
  rw [← prefix_reconstructs chunks, List.mem_append] at present
  rcases present with removed | kept
  · have allowed := removed_only_prunable chunks chunk removed
    simp [blocked] at allowed
  · exact kept

theorem prune_does_not_increase_bytes (chunks : List Chunk) :
    usedBytes (prunePrefix chunks).2 ≤ usedBytes chunks := by
  have split := congrArg usedBytes (prefix_reconstructs chunks)
  rw [used_bytes_append] at split
  omega

theorem prune_does_not_increase_count (chunks : List Chunk) :
    (prunePrefix chunks).2.length ≤ chunks.length := by
  have split := congrArg List.length (prefix_reconstructs chunks)
  rw [List.length_append] at split
  omega

theorem prune_preserves_fit (budget : Budget) (chunks : List Chunk) (fits : Fits budget chunks) :
    Fits budget (prunePrefix chunks).2 := by
  obtain ⟨reserve, bytes, count⟩ := fits
  exact ⟨reserve, Nat.le_trans (prune_does_not_increase_bytes chunks) bytes,
    Nat.le_trans (prune_does_not_increase_count chunks) count⟩

theorem blocked_head_keeps_suffix (chunk : Chunk) (rest : List Chunk)
    (blocked : prunable chunk = false) : prunePrefix (chunk :: rest) = ([], chunk :: rest) := by
  simp [prunePrefix, blocked]

theorem retention_anchor_never_decreases (firstSequence : Nat) (chunks : List Chunk) :
    firstSequence ≤ firstSequence + (prunePrefix chunks).1.length := by omega

end ConvergeAudit.Retention
