// Invalid configurations used to prove that model assumptions are enforced.
module checkpointInvalidCapacity {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 0,
    allowCrash = false,
    allowPartition = false,
    allowDrop = false
  ).* from "./CheckpointDelivery"
}

module witnessInvalidQuorumLow {
  import witnessQuorum(
    requiredApprovals = 0,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = false
  ).* from "./WitnessQuorum"
}

module witnessInvalidQuorumHigh {
  import witnessQuorum(
    requiredApprovals = 5,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = false
  ).* from "./WitnessQuorum"
}
