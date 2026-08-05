module witnessQuorumTests {
  import witnessQuorum(
    requiredApprovals = 3,
    producerSignatureValid = true,
    enforceProducerSignature = true,
    enforceRoster = true,
    allowExpire = true
  ).* from "./WitnessQuorum"

  pure def approval(witness: Actor): Response = {
    witness: witness,
    valid: true,
  }

  action sendAndDeliver(witness: Actor): bool =
    sendHonestApproval(witness).then(deliverResponse(approval(witness)))

  run threeDistinctApprovalsAdvanceReceiver =
    init
      .then(sendAndDeliver(W1))
      .then(sendAndDeliver(W2))
      .expect(state.status == Collecting)
      .then(sendAndDeliver(W3))
      .expect(and {
        state.status == Ready,
        state.acceptedWitnesses == Set(W1, W2, W3),
      })
      .then(advanceReceiver)
      .expect(state.receiverAdvanced)

  run intruderDoesNotCountTowardQuorum = {
    val response: Response = { witness: Intruder, valid: true }
    init
      .then(sendHostileResponse(Intruder, true))
      .then(deliverResponse(response))
      .expect(and {
        state.status == Collecting,
        state.acceptedWitnesses == Set(),
      })
  }

  run expiryDoesNotAdvanceReceiver =
    init
      .then(expire)
      .expect(and {
        state.status == Expired,
        state.classification == Pending,
        not(state.receiverAdvanced),
      })
      .then(advanceReceiver.fail())
}
