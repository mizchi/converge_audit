import Std

namespace ConvergeAudit

/-- Authenticated immutable facts only. Mutable local availability and finality
status are not elements of this grow-only evidence lattice. -/
abbrev Knowledge (Fact : Type) := Fact → Prop

def merge {Fact : Type} (a b : Knowledge Fact) : Knowledge Fact :=
  fun fact => a fact ∨ b fact

def Extends {Fact : Type} (a b : Knowledge Fact) : Prop := ∀ f, a f → b f

theorem merge_comm {Fact : Type} (a b : Knowledge Fact) : merge a b = merge b a := by
  funext f
  exact propext (Or.comm)

theorem merge_assoc {Fact : Type} (a b c : Knowledge Fact) :
    merge (merge a b) c = merge a (merge b c) := by
  funext f
  exact propext (or_assoc)

theorem merge_idem {Fact : Type} (a : Knowledge Fact) : merge a a = a := by
  funext f
  exact propext ⟨fun h => h.elim id id, Or.inl⟩

theorem merge_extends_left {Fact : Type} (a b : Knowledge Fact) : Extends a (merge a b) := by
  exact fun _ h => Or.inl h

/-- Evidence such as an authenticated fork can never disappear after merge. -/
theorem evidence_persists {Fact : Type} (a b : Knowledge Fact) (fact : Fact)
    (known : a fact) : merge a b fact := Or.inl known

/-- Absence of an objection is not stable when more facts arrive. -/
theorem silence_not_monotone :
    ∃ a b : Knowledge Unit, Extends a b ∧ ¬ a () ∧ b () := by
  exact ⟨fun _ => False, fun _ => True, fun _ h => False.elim h, id, True.intro⟩

end ConvergeAudit
