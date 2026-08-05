// Deterministic model-based-testing driver over the authoritative witness
// protocol. The trace crosses a valid intruder response, an invalid roster
// signature, three distinct honest approvals, and the receiver gate.
module witnessQuorumMbt {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = false
  ) as protocol from "./WitnessQuorum"

  var phase: int

  pure val IntruderApproval: protocol::Response = {
    witness: protocol::Intruder,
    valid: true,
  }

  pure val W1Approval: protocol::Response = {
    witness: protocol::W1,
    valid: true,
  }

  pure val InvalidW2Approval: protocol::Response = {
    witness: protocol::W2,
    valid: false,
  }

  pure val W2Approval: protocol::Response = {
    witness: protocol::W2,
    valid: true,
  }

  pure val W3Approval: protocol::Response = {
    witness: protocol::W3,
    valid: true,
  }

  action init = all {
    protocol::init,
    phase' = 0,
  }

  action sendIntruder = all {
    phase == 0,
    protocol::sendHostileResponse(protocol::Intruder, true),
    phase' = 1,
  }

  action deliverIntruder = all {
    phase == 1,
    protocol::deliverResponse(IntruderApproval),
    phase' = 2,
  }

  action sendW1 = all {
    phase == 2,
    protocol::sendHonestApproval(protocol::W1),
    phase' = 3,
  }

  action deliverW1 = all {
    phase == 3,
    protocol::deliverResponse(W1Approval),
    phase' = 4,
  }

  action sendInvalidW2 = all {
    phase == 4,
    protocol::sendHostileResponse(protocol::W2, false),
    phase' = 5,
  }

  action deliverInvalidW2 = all {
    phase == 5,
    protocol::deliverResponse(InvalidW2Approval),
    phase' = 6,
  }

  action sendW2 = all {
    phase == 6,
    protocol::sendHonestApproval(protocol::W2),
    phase' = 7,
  }

  action deliverW2 = all {
    phase == 7,
    protocol::deliverResponse(W2Approval),
    phase' = 8,
  }

  action sendW3 = all {
    phase == 8,
    protocol::sendHonestApproval(protocol::W3),
    phase' = 9,
  }

  action deliverW3 = all {
    phase == 9,
    protocol::deliverResponse(W3Approval),
    phase' = 10,
  }

  action advanceReceiver = all {
    phase == 10,
    protocol::advanceReceiver,
    phase' = 11,
  }

  action step = any {
    sendIntruder,
    deliverIntruder,
    sendW1,
    deliverW1,
    sendInvalidW2,
    deliverInvalidW2,
    sendW2,
    deliverW2,
    sendW3,
    deliverW3,
    advanceReceiver,
  }

  val completed = phase == 11 and protocol::state.receiverAdvanced
}
