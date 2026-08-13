module observerSigningStoreSafety {
  import observerSigningStore(durableReservationEnabled = true).* from "./ObserverSigningStore"
}

module observerSigningStoreBrokenDurability {
  import observerSigningStore(durableReservationEnabled = false).* from "./ObserverSigningStore"
}
