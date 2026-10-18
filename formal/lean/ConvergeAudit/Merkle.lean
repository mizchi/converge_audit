import ConvergeAudit.RangeDispute

namespace ConvergeAudit.Merkle

inductive Kind where
  | states
  | commands
  deriving DecidableEq, Repr

structure Metadata (Context : Type) where
  context : Context
  kind : Kind
  count : Nat
  deriving DecidableEq, Repr

/-- Structured, domain-separated preimages. A concrete canonical byte encoder
must preserve this distinction; its refinement is a separate obligation. -/
inductive HashInput (Value Context Digest : Type) where
  | leaf : Value → HashInput Value Context Digest
  | node : Digest → Digest → HashInput Value Context Digest
  | root : Metadata Context → Digest → HashInput Value Context Digest
  deriving DecidableEq, Repr

abbrev Hasher (Value Context Digest : Type) := HashInput Value Context Digest → Digest

inductive Tree (Value : Type) : Nat → Type where
  | leaf : Value → Tree Value 0
  | node {depth : Nat} : Tree Value depth → Tree Value depth → Tree Value (depth + 1)

/-- Root-to-leaf directions. Depth is checked by the type; raw wire parsing is
not modeled here. Sibling values remain untrusted. -/
inductive Path (Digest : Type) : Nat → Type where
  | done : Path Digest 0
  | left {depth : Nat} : Digest → Path Digest depth → Path Digest (depth + 1)
  | right {depth : Nat} : Digest → Path Digest depth → Path Digest (depth + 1)

variable {Value Context Digest : Type}

def Path.index : {depth : Nat} → Path Digest depth → Nat
  | 0, .done => 0
  | _ + 1, .left _ tail => tail.index
  | depth + 1, .right _ tail => 2 ^ depth + tail.index

theorem path_index_lt {depth : Nat} (path : Path Digest depth) : path.index < 2 ^ depth := by
  induction path with
  | done => simp [Path.index]
  | left _ _ ih =>
    simp only [Path.index, Nat.pow_succ]
    omega
  | right _ _ ih =>
    simp only [Path.index, Nat.pow_succ]
    omega

def tabulate : (depth : Nat) → (Nat → Value) → Tree Value depth
  | 0, values => .leaf (values 0)
  | depth + 1, values =>
    .node (tabulate depth values) (tabulate depth (fun i => values (2 ^ depth + i)))

def treeHash (hash : Hasher Value Context Digest) : {depth : Nat} → Tree Value depth → Digest
  | 0, .leaf value => hash (.leaf value)
  | _ + 1, .node left right => hash (.node (treeHash hash left) (treeHash hash right))

def reconstruct (hash : Hasher Value Context Digest) (value : Value) :
    {depth : Nat} → Path Digest depth → Digest
  | 0, .done => hash (.leaf value)
  | _ + 1, .left sibling tail => hash (.node (reconstruct hash value tail) sibling)
  | _ + 1, .right sibling tail => hash (.node sibling (reconstruct hash value tail))

def lookup : {depth : Nat} → Tree Value depth → Path Digest depth → Value
  | 0, .leaf value, .done => value
  | _ + 1, .node left _, .left _ tail => lookup left tail
  | _ + 1, .node _ right, .right _ tail => lookup right tail

theorem lookup_tabulate {depth : Nat} (values : Nat → Value) (path : Path Digest depth) :
    lookup (tabulate depth values) path = values path.index := by
  induction path generalizing values with
  | done => rfl
  | left _ _ ih => exact ih values
  | right _ _ ih => exact ih (fun i => values (_ + i))

def pathInputs (hash : Hasher Value Context Digest) (value : Value) :
    {depth : Nat} → Path Digest depth → List (HashInput Value Context Digest)
  | 0, .done => [.leaf value]
  | _ + 1, .left sibling tail =>
    .node (reconstruct hash value tail) sibling :: pathInputs hash value tail
  | _ + 1, .right sibling tail =>
    .node sibling (reconstruct hash value tail) :: pathInputs hash value tail

def treeInputs (hash : Hasher Value Context Digest) :
    {depth : Nat} → Tree Value depth → List (HashInput Value Context Digest)
  | 0, .leaf value => [.leaf value]
  | _ + 1, .node left right =>
    .node (treeHash hash left) (treeHash hash right) :: (treeInputs hash left ++ treeInputs hash right)

/-- A collision among the concrete preimages used by the presented opening and
the committed tree. There is no global injectivity or collision-freedom axiom. -/
def CollisionOn (hash : Hasher Value Context Digest)
    (presented committed : List (HashInput Value Context Digest)) : Prop :=
  ∃ a, a ∈ presented ∧ ∃ b, b ∈ committed ∧ a ≠ b ∧ hash a = hash b

theorem collision_mono (hash : Hasher Value Context Digest)
    {presented committed largerPresented largerCommitted : List (HashInput Value Context Digest)}
    (collision : CollisionOn hash presented committed)
    (left : ∀ a, a ∈ presented → a ∈ largerPresented)
    (right : ∀ b, b ∈ committed → b ∈ largerCommitted) :
    CollisionOn hash largerPresented largerCommitted := by
  obtain ⟨a, ha, b, hb, different, same⟩ := collision
  exact ⟨a, left a ha, b, right b hb, different, same⟩

/-- Separate an ambiguous canonical encoder from a collision in the byte-level
hash. The two structured inputs are still constrained to the checked transcripts. -/
theorem collision_splits_encoding {Bytes : Type}
    (encode : HashInput Value Context Digest → Bytes) (digest : Bytes → Digest)
    {presented committed : List (HashInput Value Context Digest)}
    (collision : CollisionOn (fun input => digest (encode input)) presented committed) :
    ∃ a, a ∈ presented ∧ ∃ b, b ∈ committed ∧ a ≠ b ∧
      (encode a = encode b ∨ (encode a ≠ encode b ∧ digest (encode a) = digest (encode b))) := by
  classical
  obtain ⟨a, ha, b, hb, different, same⟩ := collision
  refine ⟨a, ha, b, hb, different, ?_⟩
  by_cases encodedSame : encode a = encode b
  · exact Or.inl encodedSame
  · exact Or.inr ⟨encodedSame, same⟩

theorem encoded_collision {Bytes : Type}
    (encode : HashInput Value Context Digest → Bytes) (digest : Bytes → Digest)
    {presented committed : List (HashInput Value Context Digest)}
    (unambiguous : ∀ a, a ∈ presented → ∀ b, b ∈ committed → encode a = encode b → a = b)
    (collision : CollisionOn (fun input => digest (encode input)) presented committed) :
    ∃ a, a ∈ presented ∧ ∃ b, b ∈ committed ∧
      encode a ≠ encode b ∧ digest (encode a) = digest (encode b) := by
  obtain ⟨a, ha, b, hb, different, same⟩ := collision
  exact ⟨a, ha, b, hb, (fun equal => different (unambiguous a ha b hb equal)), same⟩

theorem reconstruction_binding (hash : Hasher Value Context Digest) {depth : Nat}
    (tree : Tree Value depth) (value : Value) (path : Path Digest depth)
    (accepted : reconstruct hash value path = treeHash hash tree) :
    value = lookup tree path ∨ CollisionOn hash (pathInputs hash value path) (treeInputs hash tree) := by
  classical
  induction tree generalizing value with
  | leaf expected =>
    cases path
    by_cases same : value = expected
    · exact Or.inl same
    · exact Or.inr ⟨.leaf value, by simp [pathInputs], .leaf expected,
        by simp [treeInputs], (fun eq => same (HashInput.leaf.inj eq)), accepted⟩
  | node left right ihLeft ihRight =>
    cases path with
    | left sibling tail =>
      by_cases same : (HashInput.node (reconstruct hash value tail) sibling : HashInput Value Context Digest) =
          .node (treeHash hash left) (treeHash hash right)
      · have child := (HashInput.node.inj same).1
        cases ihLeft value tail child with
        | inl correct => exact Or.inl correct
        | inr collision =>
          apply Or.inr
          apply collision_mono hash collision
          · intro a ha
            exact List.mem_cons_of_mem _ ha
          · intro b hb
            exact List.mem_cons_of_mem _ (List.mem_append_left _ hb)
      · exact Or.inr ⟨_, List.mem_cons_self, _, List.mem_cons_self, same, accepted⟩
    | right sibling tail =>
      by_cases same : (HashInput.node sibling (reconstruct hash value tail) : HashInput Value Context Digest) =
          .node (treeHash hash left) (treeHash hash right)
      · have child := (HashInput.node.inj same).2
        cases ihRight value tail child with
        | inl correct => exact Or.inl correct
        | inr collision =>
          apply Or.inr
          apply collision_mono hash collision
          · intro a ha
            exact List.mem_cons_of_mem _ ha
          · intro b hb
            exact List.mem_cons_of_mem _ (List.mem_append_right _ hb)
      · exact Or.inr ⟨_, List.mem_cons_self, _, List.mem_cons_self, same, accepted⟩

def commitRoot (hash : Hasher Value Context Digest) (metadata : Metadata Context)
    {depth : Nat} (tree : Tree Value depth) : Digest :=
  hash (.root metadata (treeHash hash tree))

def openingInputs (hash : Hasher Value Context Digest) (metadata : Metadata Context)
    (value : Value) {depth : Nat} (path : Path Digest depth) : List (HashInput Value Context Digest) :=
  .root metadata (reconstruct hash value path) :: pathInputs hash value path

def committedInputs (hash : Hasher Value Context Digest) (metadata : Metadata Context)
    {depth : Nat} (tree : Tree Value depth) : List (HashInput Value Context Digest) :=
  .root metadata (treeHash hash tree) :: treeInputs hash tree

def verifyOpening [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (metadata : Metadata Context) (index : Nat) (value : Value)
    {depth : Nat} (path : Path Digest depth) (expectedRoot : Digest) : Bool :=
  decide (0 < metadata.count ∧ index < metadata.count ∧ path.index = index ∧
    depth = ceilLog2 metadata.count) &&
      decide (hash (.root metadata (reconstruct hash value path)) = expectedRoot)

theorem verify_opening_iff [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (metadata : Metadata Context) (index : Nat) (value : Value)
    {depth : Nat} (path : Path Digest depth) (expectedRoot : Digest) :
    verifyOpening hash metadata index value path expectedRoot = true ↔
      (0 < metadata.count ∧ index < metadata.count ∧ path.index = index ∧
        depth = ceilLog2 metadata.count) ∧
      hash (.root metadata (reconstruct hash value path)) = expectedRoot := by
  simp [verifyOpening, Bool.and_eq_true]

/-- Even a malicious hash implementation is covered: a false opening produces
a collision witness in the actual hash transcripts, not an assumed contradiction. -/
theorem opening_binding [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (requested committed : Metadata Context) {depth : Nat} (tree : Tree Value depth)
    (index : Nat) (value : Value) (path : Path Digest depth)
    (accepted : verifyOpening hash requested index value path (commitRoot hash committed tree) = true) :
    (requested = committed ∧ value = lookup tree path) ∨
      CollisionOn hash (openingInputs hash requested value path) (committedInputs hash committed tree) := by
  classical
  have hashes := ((verify_opening_iff hash requested index value path _).mp accepted).2
  by_cases same : (HashInput.root requested (reconstruct hash value path) : HashInput Value Context Digest) =
      .root committed (treeHash hash tree)
  · have parts := HashInput.root.inj same
    cases reconstruction_binding hash tree value path parts.2 with
    | inl correct => exact Or.inl ⟨parts.1, correct⟩
    | inr collision =>
      exact Or.inr (collision_mono hash collision
        (fun _ h => List.mem_cons_of_mem _ h) (fun _ h => List.mem_cons_of_mem _ h))
  · exact Or.inr ⟨_, List.mem_cons_self, _, List.mem_cons_self, same, hashes⟩

theorem opening_for_vector [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (requested committed : Metadata Context) (values : Nat → Value)
    (index : Nat) (value : Value) {depth : Nat} (path : Path Digest depth)
    (accepted : verifyOpening hash requested index value path
      (commitRoot hash committed (tabulate depth values)) = true) :
    (requested = committed ∧ value = values index) ∨
      CollisionOn hash (openingInputs hash requested value path)
        (committedInputs hash committed (tabulate depth values)) := by
  cases opening_binding hash requested committed (tabulate depth values) index value path accepted with
  | inl correct =>
    have address := ((verify_opening_iff hash requested index value path _).mp accepted).1.2.2.1
    exact Or.inl ⟨correct.1, by simpa [lookup_tabulate, address] using correct.2⟩
  | inr collision => exact Or.inr collision

def makePath (hash : Hasher Value Context Digest) :
    {depth : Nat} → Tree Value depth → Nat → Path Digest depth
  | 0, .leaf _, _ => .done
  | depth + 1, .node left right, index =>
    if index < 2 ^ depth then .left (treeHash hash right) (makePath hash left index)
    else .right (treeHash hash left) (makePath hash right (index - 2 ^ depth))

theorem make_path_index (hash : Hasher Value Context Digest) {depth : Nat}
    (tree : Tree Value depth) (index : Nat) (inside : index < 2 ^ depth) :
    (makePath hash tree index).index = index := by
  induction tree generalizing index with
  | leaf _ =>
    have zero : index = 0 := by simpa using inside
    subst index
    rfl
  | @node depth left right ihLeft ihRight =>
    simp only [makePath]
    split
    next low => exact ihLeft index low
    next high =>
      have childInside : index - 2 ^ depth < 2 ^ depth := by
        rw [Nat.pow_succ] at inside
        omega
      simp only [Path.index, ihRight _ childInside]
      omega

theorem generated_path_reconstructs (hash : Hasher Value Context Digest) {depth : Nat}
    (tree : Tree Value depth) (index : Nat) :
    reconstruct hash (lookup tree (makePath hash tree index)) (makePath hash tree index) =
      treeHash hash tree := by
  induction tree generalizing index with
  | leaf _ => rfl
  | node left right ihLeft ihRight =>
    simp only [makePath]
    split
    · simpa only [lookup, reconstruct, treeHash] using
        congrArg (fun child => hash (.node child (treeHash hash right))) (ihLeft index)
    · simpa only [lookup, reconstruct, treeHash] using
        congrArg (fun child => hash (.node (treeHash hash left) child)) (ihRight _)

theorem generated_opening_accepted [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (metadata : Metadata Context) {depth : Nat} (tree : Tree Value depth) (index : Nat)
    (positive : 0 < metadata.count) (inside : index < metadata.count)
    (minimalDepth : depth = ceilLog2 metadata.count) :
    verifyOpening hash metadata index (lookup tree (makePath hash tree index))
      (makePath hash tree index) (commitRoot hash metadata tree) = true := by
  apply (verify_opening_iff _ _ _ _ _ _).mpr
  have capacity : metadata.count ≤ 2 ^ depth := by
    rw [minimalDepth]
    exact width_fits_ceil_log2 metadata.count
  refine ⟨⟨positive, inside, make_path_index hash tree index (by omega), minimalDepth⟩, ?_⟩
  exact congrArg (fun content => hash (.root metadata content))
    (generated_path_reconstructs hash tree index)

theorem vector_opening_accepted [DecidableEq Digest] (hash : Hasher Value Context Digest)
    (metadata : Metadata Context) (values : Nat → Value) {depth : Nat} (index : Nat)
    (positive : 0 < metadata.count) (inside : index < metadata.count)
    (minimalDepth : depth = ceilLog2 metadata.count) :
    verifyOpening hash metadata index (values index) (makePath hash (tabulate depth values) index)
      (commitRoot hash metadata (tabulate depth values)) = true := by
  have bound : index < 2 ^ depth := by
    have capacity := width_fits_ceil_log2 metadata.count
    rw [← minimalDepth] at capacity
    omega
  have accepted := generated_opening_accepted hash metadata (tabulate depth values) index
    positive inside minimalDepth
  simpa only [lookup_tabulate, make_path_index hash (tabulate depth values) index bound] using accepted

theorem path_inputs_length (hash : Hasher Value Context Digest) (value : Value)
    {depth : Nat} (path : Path Digest depth) : (pathInputs hash value path).length = depth + 1 := by
  induction path with
  | done => rfl
  | left _ _ ih => simp [pathInputs, ih]
  | right _ _ ih => simp [pathInputs, ih]

theorem opening_inputs_length (hash : Hasher Value Context Digest) (metadata : Metadata Context)
    (value : Value) {depth : Nat} (path : Path Digest depth) :
    (openingInputs hash metadata value path).length = depth + 2 := by
  simp [openingInputs, path_inputs_length, Nat.add_assoc]

end ConvergeAudit.Merkle
