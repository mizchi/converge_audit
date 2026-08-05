module checkpointDeliveryTests {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 1,
    allowCrash = true,
    allowPartition = true,
    allowDrop = true
  ).* from "./CheckpointDelivery"

  pure val EventBToP1: EventMessage = {
    sender: P2,
    receiver: P1,
    event: EventB,
  }

  pure val P1Epoch1: Checkpoint = {
    producer: P1,
    epoch: 1,
    parent: Genesis,
    events: Set(EventA, EventB),
  }

  pure val P1Epoch2: Checkpoint = {
    producer: P1,
    epoch: 2,
    parent: { epoch: 1, events: Set(EventA, EventB) },
    events: Set(EventA, EventB, EventC),
  }

  action makeP1ReadyToSeal =
    sendEvent(P2, P1, EventB).then(deliverEvent(EventBToP1))

  run authorityFinalizesTwoEpochs =
    init
      .then(makeP1ReadyToSeal)
      .then(sealNextCheckpoint(P1))
      .expect(P1Epoch1.in(state.durableCheckpoints.get(P1)))
      .then(sendCheckpoint(P1, P1Epoch1))
      .then(receiveCheckpoint(P1Epoch1))
      .expect(headEpoch(Authority) == 1)
      .then(sealNextCheckpoint(P1))
      .expect(P1Epoch2.in(state.durableCheckpoints.get(P1)))
      .then(sendCheckpoint(P1, P1Epoch2))
      .then(receiveCheckpoint(P1Epoch2))
      .expect(authorityFinalized)

  run durableOutboxSurvivesCrash =
    init
      .then(makeP1ReadyToSeal)
      .then(sealNextCheckpoint(P1))
      .then(crash(P1))
      .expect(and {
        state.volatileOutbox.get(P1) == Set(),
        P1Epoch1.in(state.durableOutbox.get(P1)),
      })
      .then(restart(P1))
      .then(sendCheckpoint(P1, P1Epoch1))
      .then(receiveCheckpoint(P1Epoch1))
      .expect(headEpoch(Authority) == 1)

  run fullOutboxBlocksNextSeal =
    init
      .then(makeP1ReadyToSeal)
      .then(sealNextCheckpoint(P1))
      .expect(headEpoch(PeerNode(P1)) == 1)
      .then(sealNextCheckpoint(P1).fail())
}
