// Concrete healthy and deliberately broken checkpoint-delivery configurations.
module checkpointSafety {
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
}

module checkpointBrokenCompleteness {
  import checkpointDelivery(
    requireCompleteBeforeSeal = false,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 1,
    allowCrash = false,
    allowPartition = false,
    allowDrop = false
  ).* from "./CheckpointDelivery"
}

module checkpointBrokenOutbox {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = false,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 1,
    allowCrash = true,
    allowPartition = false,
    allowDrop = false
  ).* from "./CheckpointDelivery"
}

module checkpointBrokenParent {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = false,
    retryEnabled = true,
    enforceOutboxCapacity = true,
    outboxCapacity = 2,
    allowCrash = false,
    allowPartition = false,
    allowDrop = false
  ).* from "./CheckpointDelivery"
}

module checkpointBrokenRetry {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = false,
    enforceOutboxCapacity = true,
    outboxCapacity = 1,
    allowCrash = false,
    allowPartition = false,
    allowDrop = true
  ).* from "./CheckpointDelivery"
}

module checkpointBrokenBackpressure {
  import checkpointDelivery(
    requireCompleteBeforeSeal = true,
    durableOutboxEnabled = true,
    exactParentEnabled = true,
    retryEnabled = true,
    enforceOutboxCapacity = false,
    outboxCapacity = 1,
    allowCrash = false,
    allowPartition = false,
    allowDrop = false
  ).* from "./CheckpointDelivery"
}
