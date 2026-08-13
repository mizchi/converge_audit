// Durable reserve-before-sign protocol for one open-world observer.
//
// The finite model abstracts a canonical signing key as Slot and the signed
// encounter digest as Digest. Cryptographic unforgeability and SQLite are
// outside this model; the host adapter refines `reservations` to one Durable
// Object SQLite transaction.
module observerSigningStore {
  type Slot = Slot0 | Slot1
  type Digest = DigestA | DigestB

  type Reservation = {
    slot: Slot,
    digest: Digest,
  }

  type Signature = {
    slot: Slot,
    digest: Digest,
  }

  type State = {
    reservations: Set[Reservation],
    signatures: Set[Signature],
    up: bool,
  }

  const durableReservationEnabled: bool

  pure val Slots = Set(Slot0, Slot1)
  pure val Digests = Set(DigestA, DigestB)

  var state: State

  action init = {
    state' = {
      reservations: Set(),
      signatures: Set(),
      up: true,
    }
  }

  /// Reserve a previously unused slot, or accept an exact idempotent retry.
  /// A conflicting digest has no enabled transition.
  action reserve(slot: Slot, digest: Digest): bool = {
    val reservation = { slot: slot, digest: digest }
    val existing = state.reservations.filter(entry => entry.slot == slot)
    all {
      state.up,
      existing.size() == 0 or reservation.in(existing),
      state' = {
        ...state,
        reservations: state.reservations.union(Set(reservation)),
      },
    }
  }

  /// The signer is callable only after the exact durable reservation exists.
  action sign(slot: Slot, digest: Digest): bool = {
    val reservation = { slot: slot, digest: digest }
    all {
      state.up,
      reservation.in(state.reservations),
      state' = {
        ...state,
        signatures: state.signatures.union(Set(reservation)),
      },
    }
  }

  /// Signer failure does not roll back its already committed reservation.
  action failSigning(slot: Slot, digest: Digest): bool = all {
    state.up,
    { slot: slot, digest: digest }.in(state.reservations),
    state' = state,
  }

  /// The Red configuration deliberately loses reservations at crash.
  action crash: bool = all {
    state.up,
    state' = {
      ...state,
      reservations:
        if (durableReservationEnabled) state.reservations else Set(),
      up: false,
    },
  }

  action restart: bool = all {
    not(state.up),
    state' = { ...state, up: true },
  }

  action reserveSome = {
    nondet slot = Slots.oneOf()
    nondet digest = Digests.oneOf()
    reserve(slot, digest)
  }

  action signSome = {
    nondet slot = Slots.oneOf()
    nondet digest = Digests.oneOf()
    sign(slot, digest)
  }

  action failSomeSigning = {
    nondet slot = Slots.oneOf()
    nondet digest = Digests.oneOf()
    failSigning(slot, digest)
  }

  action step = any {
    reserveSome,
    signSome,
    failSomeSigning,
    crash,
    restart,
  }

  val typeOk = and {
    state.reservations.forall(entry =>
      entry.slot.in(Slots) and entry.digest.in(Digests)),
    state.signatures.forall(entry =>
      entry.slot.in(Slots) and entry.digest.in(Digests)),
  }

  /// One canonical slot has at most one durable digest reservation.
  val oneReservationPerSlot = Slots.forall(slot =>
    state.reservations.filter(entry => entry.slot == slot).size() <= 1)

  /// A signature cannot outlive or precede its exact reservation.
  val everySignatureHasExactReservation =
    state.signatures.subseteq(state.reservations)

  /// Even after crash/retry, one slot never signs two encounter digests.
  val noDoubleSigning = Slots.forall(slot =>
    state.signatures.filter(entry => entry.slot == slot).size() <= 1)
}
