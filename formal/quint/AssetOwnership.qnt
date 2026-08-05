// Authoritative per-asset ownership/listing lifecycle model.
//
// Cryptographic algorithms are abstracted to signature-validity booleans. The
// model checks only monotonic owner heads and the transfer/list/cancel guards.
module assetOwnership {
  type Owner = O1 | O2 | O3
  type ListingStatus = NeverListed | Active | Canceled | Quarantined
  type ListingNonce = N1 | N2 | N3

  type State = {
    owner: Owner,
    ownerVersion: int,
    transferCount: int,
    listingStatus: ListingStatus,
    listingOwner: Owner,
    listingVersion: int,
    listingNonce: ListingNonce,
    canceledListingNonces: Set[ListingNonce],
    revokedAncestors: Set[int],
    lineageClean: bool,
    lastTransferLineageClean: bool,
    lastSenderAuthenticated: bool,
    lastRecipientAuthenticated: bool,
  }

  const enforceSenderSignature: bool
  const enforceRecipientSignature: bool
  const enforceExactVersion: bool
  const blockTransferWhileListed: bool
  const quarantineOnRevocation: bool
  const blockUseOnRevocation: bool

  pure val Owners = Set(O1, O2, O3)
  pure val Versions = Set(0, 1, 2)
  pure val ListingNonces = Set(N1, N2, N3)

  var state: State

  /// Start at the origin receipt's version-zero owner head with no listing.
  action init = {
    state' = {
      owner: O1,
      ownerVersion: 0,
      transferCount: 0,
      listingStatus: NeverListed,
      listingOwner: O1,
      listingVersion: -1,
      listingNonce: N1,
      canceledListingNonces: Set(),
      revokedAncestors: Set(),
      lineageClean: true,
      lastTransferLineageClean: true,
      lastSenderAuthenticated: true,
      lastRecipientAuthenticated: true,
    }
  }

  /// Advance one exact owner head after both transfer participants authenticate.
  action transfer(
    from: Owner,
    recipient: Owner,
    previousVersion: int,
    nextVersion: int,
    senderAuthenticated: bool,
    recipientAuthenticated: bool,
  ): bool = all {
    from == state.owner,
    recipient != from,
    previousVersion == state.ownerVersion,
    nextVersion.in(Versions),
    not(enforceExactVersion) or nextVersion == previousVersion + 1,
    not(enforceSenderSignature) or senderAuthenticated,
    not(enforceRecipientSignature) or recipientAuthenticated,
    not(blockTransferWhileListed) or state.listingStatus != Active,
    not(blockUseOnRevocation) or state.lineageClean,
    state' = {
      ...state,
      owner: recipient,
      ownerVersion: nextVersion,
      transferCount: state.transferCount + 1,
      lastTransferLineageClean: state.lineageClean,
      lastSenderAuthenticated: senderAuthenticated,
      lastRecipientAuthenticated: recipientAuthenticated,
    },
  }

  /// Create a listing only for the exact current owner head. A canceled listing
  /// nonce cannot be replayed; a fresh nonce permits an intentional relisting.
  action list(
    seller: Owner,
    ownerVersion: int,
    nonce: ListingNonce,
    ownerAuthenticated: bool,
  ): bool = all {
    seller == state.owner,
    ownerVersion == state.ownerVersion,
    ownerAuthenticated,
    state.lineageClean,
    state.listingStatus != Active,
    not(nonce.in(state.canceledListingNonces)),
    state' = {
      ...state,
      listingStatus: Active,
      listingOwner: seller,
      listingVersion: ownerVersion,
      listingNonce: nonce,
    },
  }

  /// Cancel only an active listing owned by the exact current owner head.
  action cancel(
    seller: Owner,
    ownerVersion: int,
    ownerAuthenticated: bool,
  ): bool = all {
    state.listingStatus == Active,
    seller == state.owner,
    seller == state.listingOwner,
    ownerVersion == state.ownerVersion,
    ownerVersion == state.listingVersion,
    ownerAuthenticated,
    state' = {
      ...state,
      listingStatus: Canceled,
      canceledListingNonces:
        state.canceledListingNonces.union(Set(state.listingNonce)),
    },
  }

  /// Revoke any origin/transfer node in the loaded linear ancestry. Descendant
  /// ownership remains as evidence, but an active listing is quarantined and
  /// its nonce can never be replayed.
  action revokeAncestor(version: int): bool = all {
    version.in(Versions),
    version <= state.ownerVersion,
    not(version.in(state.revokedAncestors)),
    state' = {
      ...state,
      listingStatus:
        if (quarantineOnRevocation and state.listingStatus == Active)
          Quarantined
        else state.listingStatus,
      canceledListingNonces:
        if (quarantineOnRevocation and state.listingStatus == Active)
          state.canceledListingNonces.union(Set(state.listingNonce))
        else state.canceledListingNonces,
      revokedAncestors: state.revokedAncestors.union(Set(version)),
      lineageClean: false,
    },
  }

  /// A successful appeal removes exactly one revocation and recomputes the
  /// lineage flag. Quarantined listings never reactivate implicitly.
  action restoreAncestor(version: int): bool = {
    val remaining = state.revokedAncestors.exclude(Set(version))
    all {
      version.in(state.revokedAncestors),
      state' = {
        ...state,
        revokedAncestors: remaining,
        lineageClean: remaining.size() == 0,
      },
    }
  }

  action transferSome = {
    nondet from = Owners.oneOf()
    nondet recipient = Owners.oneOf()
    nondet previousVersion = Versions.oneOf()
    nondet nextVersion = Versions.oneOf()
    nondet senderAuthenticated = Set(true, false).oneOf()
    nondet recipientAuthenticated = Set(true, false).oneOf()
    transfer(
      from,
      recipient,
      previousVersion,
      nextVersion,
      senderAuthenticated,
      recipientAuthenticated,
    )
  }

  action listSome = {
    nondet seller = Owners.oneOf()
    nondet version = Versions.oneOf()
    nondet nonce = ListingNonces.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    list(seller, version, nonce, authenticated)
  }

  action cancelSome = {
    nondet seller = Owners.oneOf()
    nondet version = Versions.oneOf()
    nondet authenticated = Set(true, false).oneOf()
    cancel(seller, version, authenticated)
  }

  action revokeSome = {
    nondet version = Versions.oneOf()
    revokeAncestor(version)
  }

  action restoreSome = {
    nondet version = Versions.oneOf()
    restoreAncestor(version)
  }

  action step = any {
    transferSome,
    listSome,
    cancelSome,
    revokeSome,
    restoreSome,
  }

  val typeOk = and {
    state.owner.in(Owners),
    state.ownerVersion.in(Versions),
    state.transferCount >= 0,
    state.transferCount <= 2,
    state.listingOwner.in(Owners),
    state.listingNonce.in(ListingNonces),
    state.listingVersion >= -1,
    state.listingVersion <= 2,
    state.revokedAncestors.subseteq(Versions),
  }

  val ownerVersionAdvancesExactlyOnce =
    state.ownerVersion == state.transferCount

  val transferRequiresDualAuthentication =
    state.transferCount > 0 implies and {
      state.lastSenderAuthenticated,
      state.lastRecipientAuthenticated,
    }

  val transferRequiresCleanLineage =
    state.transferCount > 0 implies state.lastTransferLineageClean

  val activeListingMatchesCurrentOwnerHead =
    state.listingStatus == Active implies and {
      state.listingOwner == state.owner,
      state.listingVersion == state.ownerVersion,
    }

  val lineageFlagMatchesRevocations =
    state.lineageClean == (state.revokedAncestors.size() == 0)

  val activeListingRequiresCleanLineage =
    state.listingStatus == Active implies state.lineageClean

  val safety = and {
    typeOk,
    ownerVersionAdvancesExactlyOnce,
    transferRequiresDualAuthentication,
    transferRequiresCleanLineage,
    activeListingMatchesCurrentOwnerHead,
    lineageFlagMatchesRevocations,
    activeListingRequiresCleanLineage,
  }
}
