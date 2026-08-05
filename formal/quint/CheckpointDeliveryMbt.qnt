// Deterministic model-based-testing driver over the authoritative protocol.
// Every transition delegates to a real checkpointDelivery action; `phase`
// merely chooses one representative trace that crosses crash recovery and
// reuses a capacity-one outbox after a successful ACK.
module checkpointDeliveryMbt {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 1,
    allowCrash = true,
    allowPartition = false,
    allowDrop = false
  ) as protocol from "./CheckpointDelivery"

  var phase: int

  pure val EventBToP1: protocol::EventMessage = {
    sender: protocol::P2,
    receiver: protocol::P1,
    event: protocol::EventB,
  }

  pure val P1Epoch1: protocol::Checkpoint = {
    producer: protocol::P1,
    epoch: 1,
    parent: protocol::Genesis,
    events: Set(protocol::EventA, protocol::EventB),
  }

  pure val P1Epoch2: protocol::Checkpoint = {
    producer: protocol::P1,
    epoch: 2,
    parent: { epoch: 1, events: Set(protocol::EventA, protocol::EventB) },
    events: Set(protocol::EventA, protocol::EventB, protocol::EventC),
  }

  action init = all {
    protocol::init,
    phase' = 0,
  }

  action gossipEpoch1Event = all {
    phase == 0,
    protocol::sendEvent(protocol::P2, protocol::P1, protocol::EventB),
    phase' = 1,
  }

  action deliverEpoch1Event = all {
    phase == 1,
    protocol::deliverEvent(EventBToP1),
    phase' = 2,
  }

  action sealEpoch1 = all {
    phase == 2,
    protocol::sealNextCheckpoint(protocol::P1),
    phase' = 3,
  }

  action crashAfterSeal = all {
    phase == 3,
    protocol::crash(protocol::P1),
    phase' = 4,
  }

  action restartWithDurableOutbox = all {
    phase == 4,
    protocol::restart(protocol::P1),
    phase' = 5,
  }

  action sendEpoch1 = all {
    phase == 5,
    protocol::sendCheckpoint(protocol::P1, P1Epoch1),
    phase' = 6,
  }

  action receiveEpoch1 = all {
    phase == 6,
    protocol::receiveCheckpoint(P1Epoch1),
    phase' = 7,
  }

  action sealEpoch2 = all {
    phase == 7,
    protocol::sealNextCheckpoint(protocol::P1),
    phase' = 8,
  }

  action sendEpoch2 = all {
    phase == 8,
    protocol::sendCheckpoint(protocol::P1, P1Epoch2),
    phase' = 9,
  }

  action receiveEpoch2 = all {
    phase == 9,
    protocol::receiveCheckpoint(P1Epoch2),
    phase' = 10,
  }

  action step = any {
    gossipEpoch1Event,
    deliverEpoch1Event,
    sealEpoch1,
    crashAfterSeal,
    restartWithDurableOutbox,
    sendEpoch1,
    receiveEpoch1,
    sealEpoch2,
    sendEpoch2,
    receiveEpoch2,
  }

  val completed = phase == 10 and protocol::authorityFinalized
}
