module assetOwnershipTests {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true,
    quarantineOnRevocation = true,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"

  run transferListCancelTransfer =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(list(O2, 1, N1, true))
      .then(cancel(O2, 1, true))
      .then(transfer(O2, O3, 1, 2, true, true))
      .then(list(O3, 2, N2, true))
      .expect(and {
        state.owner == O3,
        state.ownerVersion == 2,
        state.listingStatus == Active,
        state.listingOwner == O3,
      })

  run activeListingBlocksTransfer =
    init
      .then(list(O1, 0, N1, true))
      .then(transfer(O1, O2, 0, 1, true, true).fail())

  run recipientMustAcceptTransfer =
    init
      .then(transfer(O1, O2, 0, 1, true, false).fail())

  run canceledListingCannotReplay =
    init
      .then(list(O1, 0, N1, true))
      .then(cancel(O1, 0, true))
      .then(list(O1, 0, N1, true).fail())

  run canceledOwnerCanRelistWithFreshNonce =
    init
      .then(list(O1, 0, N1, true))
      .then(cancel(O1, 0, true))
      .then(list(O1, 0, N2, true))
      .expect(and {
        state.owner == O1,
        state.ownerVersion == 0,
        state.listingStatus == Active,
        state.listingNonce == N2,
      })

  run ancestorRevocationQuarantinesDescendantListing =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(list(O2, 1, N1, true))
      .then(registerLineageSlice(0, 1, true, true, true))
      .then(revokeAncestor(0))
      .expect(and {
        state.owner == O2,
        state.ownerVersion == 1,
        state.listingStatus == Quarantined,
        not(state.lineageClean),
      })

  run appealRecomputesButDoesNotReactivateListing =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(list(O2, 1, N1, true))
      .then(registerLineageSlice(0, 1, true, true, true))
      .then(revokeAncestor(0))
      .then(restoreAncestor(0))
      .then(list(O2, 1, N2, true))
      .expect(and {
        state.listingStatus == Active,
        state.listingNonce == N2,
        state.lineageClean,
      })

  run appealDoesNotPermitQuarantinedNonceReplay =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(list(O2, 1, N1, true))
      .then(registerLineageSlice(0, 1, true, true, true))
      .then(revokeAncestor(0))
      .then(restoreAncestor(0))
      .then(list(O2, 1, N1, true).fail())

  run oneAppealDoesNotClearAnotherRevokedAncestor =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(list(O2, 1, N1, true))
      .then(registerLineageSlice(0, 1, true, true, true))
      .then(revokeAncestor(0))
      .then(revokeAncestor(1))
      .then(restoreAncestor(0))
      .expect(and {
        state.listingStatus == Quarantined,
        not(state.lineageClean),
        state.revokedAncestors == Set(1),
      })

  run revokedLineageBlocksTransfer =
    init
      .then(revokeAncestor(0))
      .then(transfer(O1, O2, 0, 1, true, true).fail())

  run appealRestoresTransfer =
    init
      .then(revokeAncestor(0))
      .then(restoreAncestor(0))
      .then(transfer(O1, O2, 0, 1, true, true))
      .expect(and {
        state.owner == O2,
        state.ownerVersion == 1,
        state.lineageClean,
      })

  run unprovenHistoricalTransferCannotBeRevoked =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(revokeAncestor(1).fail())

  run authenticatedSliceEnablesHistoricalRevocation =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(registerLineageSlice(0, 1, true, true, true))
      .then(revokeAncestor(1))
      .expect(and {
        state.retainedAnchorVersion == 1,
        state.verifiedAncestors == Set(0, 1),
        state.revokedAncestors == Set(1),
      })

  run wrongParentSliceIsRejected =
    init
      .then(transfer(O1, O2, 0, 1, true, true))
      .then(registerLineageSlice(0, 1, true, false, true).fail())
}
