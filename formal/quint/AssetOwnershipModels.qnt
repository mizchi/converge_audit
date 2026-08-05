// Healthy and deliberately broken per-asset ownership configurations.
module assetOwnershipSafety {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenRecipient {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = false,
    enforceExactVersion = true,
    blockTransferWhileListed = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenVersion {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = false,
    blockTransferWhileListed = true
  ).* from "./AssetOwnership"
}

module assetOwnershipBrokenListingGate {
  import assetOwnership(
    enforceSenderSignature = true,
    enforceRecipientSignature = true,
    enforceExactVersion = true,
    blockTransferWhileListed = false
  ).* from "./AssetOwnership"
}
