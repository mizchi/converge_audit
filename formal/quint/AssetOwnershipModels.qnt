// Healthy and deliberately broken per-asset ownership configurations.
module assetOwnershipSafety {
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
}

module assetOwnershipBrokenRecipient {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = false,
    enforceExactVersion = true,
    blockTransferWhileListed = true,
    quarantineOnRevocation = true,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenVersion {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = false,
    blockTransferWhileListed = true,
    quarantineOnRevocation = true,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenListingGate {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = false,
    quarantineOnRevocation = true,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenRevocationPropagation {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true,
    quarantineOnRevocation = false,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenRevokedTransfer {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true,
    quarantineOnRevocation = true,
    blockUseOnRevocation = false,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = true,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenLineageParent {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true,
    quarantineOnRevocation = true,
    blockUseOnRevocation = true,
    enforceLineageProofAuthentication = true,
    enforceLineageParent = false,
    enforceLineageTerminal = true
  ).* from "./AssetOwnership"
}
