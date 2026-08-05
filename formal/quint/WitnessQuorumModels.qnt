// Concrete healthy and deliberately broken witness-quorum configurations.
module witnessSafety {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = true
  ).* from "./WitnessQuorum"
}

module witnessLiveness {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = false
  ).* from "./WitnessQuorum"
}

module witnessBrokenProducer {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = false,
    enforceProducerSignature = false,
    enforceRoster = true,
    allowExpire = true
  ).* from "./WitnessQuorum"
}

module witnessBrokenRoster {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = false,
    allowExpire = true
  ).* from "./WitnessQuorum"
}
