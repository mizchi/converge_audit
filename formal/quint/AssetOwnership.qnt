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
    verifiedAncestors: Set[int],
    retainedAnchorVersion: int,
    lineageProofCount: int,
    lineageClean: bool,
    lastTransferLineageClean: bool,
    lastSenderAuthenticated: bool,
    lastRecipientAuthenticated: bool,
    lastLineageProofAuthenticated: bool,
    lastLineageParentMatches: bool,
    lastLineageTerminalMatches: bool,
  }

  const enforceSenderSignature: bool
  const enforceRecipientSignature: bool
  const enforceExactVersion: bool
  const blockTransferWhileListed: bool
  const quarantineOnRevocation: bool
  const blockUseOnRevocation: bool
  const enforceLineageProofAuthentication: bool
  const enforceLineageParent: bool
  const enforceLineageTerminal: bool

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
      verifiedAncestors: Set(0),
      retainedAnchorVersion: 0,
      lineageProofCount: 0,
      lineageClean: true,
      lastTransferLineageClean: true,
      lastSenderAuthenticated: true,
      lastRecipientAuthenticated: true,
      lastLineageProofAuthenticated: true,
      lastLineageParentMatches: true,
      lastLineageTerminalMatches: true,
    }
  }

  /// Admit only a bounded contiguous suffix from the retained anchor to an
  /// already checkpoint-authenticated current owner version. Hash/signature
  /// details are abstracted to three booleans and checked by Red models.
  action registerLineageSlice(
    startVersion: int,
    endVersion: int,
    proofAuthenticated: bool,
    parentMatches: bool,
    terminalMatches: bool,
  ): bool = all {
    startVersion.in(Versions),
    endVersion.in(Versions),
    startVersion == state.retainedAnchorVersion,
    endVersion > startVersion,
    endVersion <= state.ownerVersion,
    not(enforceLineageProofAuthentication) or proofAuthenticated,
    not(enforceLineageParent) or parentMatches,
    not(enforceLineageTerminal) or terminalMatches,
    state' = {
      ...state,
      verifiedAncestors:
        state.verifiedAncestors.union(Versions.filter(v => v <= endVersion)),
      retainedAnchorVersion: endVersion,
      lineageProofCount: state.lineageProofCount + 1,
      lastLineageProofAuthenticated: proofAuthenticated,
      lastLineageParentMatches: parentMatches,
      lastLineageTerminalMatches: terminalMatches,
    },
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
    version.in(state.verifiedAncestors),
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

  action registerLineageSome = {
    nondet startVersion = Versions.oneOf()
    nondet endVersion = Versions.oneOf()
    nondet proofAuthenticated = Set(true, false).oneOf()
    nondet parentMatches = Set(true, false).oneOf()
    nondet terminalMatches = Set(true, false).oneOf()
    registerLineageSlice(
      startVersion,
      endVersion,
      proofAuthenticated,
      parentMatches,
      terminalMatches,
    )
  }

  action restoreSome = {
    nondet version = Versions.oneOf()
    restoreAncestor(version)
  }

  action step = any {
    transferSome,
    listSome,
    cancelSome,
    registerLineageSome,
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
    state.verifiedAncestors.subseteq(Versions),
    state.retainedAnchorVersion.in(Versions),
    state.lineageProofCount >= 0,
    state.lineageProofCount <= 2,
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

  val verifiedAncestorsRespectRetentionBoundary =
    state.verifiedAncestors.forall(version =>
      version <= state.retainedAnchorVersion)

  val registeredSliceRequiresExactBoundary =
    state.lineageProofCount > 0 implies and {
      state.lastLineageProofAuthenticated,
      state.lastLineageParentMatches,
      state.lastLineageTerminalMatches,
    }

  val safety = and {
    typeOk,
    ownerVersionAdvancesExactlyOnce,
    transferRequiresDualAuthentication,
    transferRequiresCleanLineage,
    activeListingMatchesCurrentOwnerHead,
    lineageFlagMatchesRevocations,
    activeListingRequiresCleanLineage,
    verifiedAncestorsRespectRetentionBoundary,
    registeredSliceRequiresExactBoundary,
  }
}
