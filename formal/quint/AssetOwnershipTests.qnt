module assetOwnershipTests {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true
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
}
