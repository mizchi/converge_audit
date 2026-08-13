module observerSigningStoreTests {
  import observerSigningStore(durableReservationEnabled = true).* from "./ObserverSigningStore"

  run exactRetryIsIdempotent =
    init
      .then(reserve(Slot0, DigestA))
      .then(sign(Slot0, DigestA))
      .then(reserve(Slot0, DigestA))
      .then(sign(Slot0, DigestA))
      .expect(state.signatures.size() == 1)

  run conflictingDigestIsRejected =
    init
      .then(reserve(Slot0, DigestA))
      .then(sign(Slot0, DigestA))
      .then(reserve(Slot0, DigestB).fail())

  run signerFailureKeepsReservationAcrossCrash =
    init
      .then(reserve(Slot0, DigestA))
      .then(failSigning(Slot0, DigestA))
      .then(crash)
      .then(restart)
      .then(sign(Slot0, DigestA))
      .expect({ slot: Slot0, digest: DigestA }.in(state.signatures))
      .then(reserve(Slot0, DigestB).fail())
}
