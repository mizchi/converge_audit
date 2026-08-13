// Healthy and deliberately broken historical-key configurations.
module keyLifecycleSafety {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = true,
    appendLifecycleEvent = true
  ).* from "./KeyLifecycle"
}

module keyLifecycleBrokenBinding {
  import keyLifecycle(
    enforceExactKeyBinding = false,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = true,
    appendLifecycleEvent = true
  ).* from "./KeyLifecycle"
}

module keyLifecycleBrokenIssuanceValidity {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = false,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = true,
    appendLifecycleEvent = true
  ).* from "./KeyLifecycle"
}

module keyLifecycleBrokenRevocation {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = false,
    retainHistoricalKeys = true,
    appendLifecycleEvent = true
  ).* from "./KeyLifecycle"
}

module keyLifecycleBrokenHistoryRetention {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = false,
    appendLifecycleEvent = true
  ).* from "./KeyLifecycle"
}

module keyLifecycleBrokenEventAtomicity {
  import keyLifecycle(
    enforceExactKeyBinding = true,
    enforceIssuanceValidity = true,
    enforceEffectiveRevocation = true,
    retainHistoricalKeys = true,
    appendLifecycleEvent = false
  ).* from "./KeyLifecycle"
}
