///|
fn revocation_trace_fixture() -> String {
  (
    #|{
    #|  "states": [
    #|    {
    #|      "#meta": { "index": 0 },
    #|      "mbt::actionTaken": "init",
    #|      "mbt::nondetPicks": {},
    #|      "state": {
    #|        "owner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "ownerVersion": { "#bigint": "0" },
    #|        "transferCount": { "#bigint": "0" },
    #|        "listingStatus": { "tag": "NeverListed", "value": { "#tup": [] } },
    #|        "listingOwner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "listingVersion": { "#bigint": "-1" },
    #|        "listingNonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "canceledListingNonces": { "#set": [] },
    #|        "revokedAncestors": { "#set": [] },
    #|        "lineageClean": true,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true
    #|      }
    #|    },
    #|    {
    #|      "#meta": { "index": 1 },
    #|      "mbt::actionTaken": "listSome",
    #|      "mbt::nondetPicks": {
    #|        "seller": { "tag": "O1", "value": { "#tup": [] } },
    #|        "version": { "#bigint": "0" },
    #|        "nonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "authenticated": true
    #|      },
    #|      "state": {
    #|        "owner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "ownerVersion": { "#bigint": "0" },
    #|        "transferCount": { "#bigint": "0" },
    #|        "listingStatus": { "tag": "Active", "value": { "#tup": [] } },
    #|        "listingOwner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "listingVersion": { "#bigint": "0" },
    #|        "listingNonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "canceledListingNonces": { "#set": [] },
    #|        "revokedAncestors": { "#set": [] },
    #|        "lineageClean": true,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true
    #|      }
    #|    },
    #|    {
    #|      "#meta": { "index": 2 },
    #|      "mbt::actionTaken": "revokeSome",
    #|      "mbt::nondetPicks": { "version": { "#bigint": "0" } },
    #|      "state": {
    #|        "owner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "ownerVersion": { "#bigint": "0" },
    #|        "transferCount": { "#bigint": "0" },
    #|        "listingStatus": { "tag": "Quarantined", "value": { "#tup": [] } },
    #|        "listingOwner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "listingVersion": { "#bigint": "0" },
    #|        "listingNonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "canceledListingNonces": {
    #|          "#set": [{ "tag": "N1", "value": { "#tup": [] } }]
    #|        },
    #|        "revokedAncestors": { "#set": [{ "#bigint": "0" }] },
    #|        "lineageClean": false,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true
    #|      }
    #|    }
    #|  ]
    #|}
  )
}

///|
test "Quint asset revocation trace matches the MoonBit audit policy" {
  let trace = @quint_connect.parse_itf_with_config(revocation_trace_fixture(), {
    state_path: ["state"],
    nondet_path: [],
  }).unwrap()
  let summary = replay_asset_ownership(trace, new_asset_driver()).unwrap()
  assert_eq(summary.states_checked, 3)
}

///|
test "Quint Connect detects an implementation that skips quarantine" {
  let trace = @quint_connect.parse_itf_with_config(revocation_trace_fixture(), {
    state_path: ["state"],
    nondet_path: [],
  }).unwrap()
  match
    replay_asset_ownership(trace, new_asset_driver(broken_revocation=true)) {
    Err(StateDiverged(2, "revokeSome", expected, actual)) => {
      assert_true(expected.contains("Quarantined"))
      assert_true(actual.contains("Active"))
    }
    _ => fail("broken revocation propagation must diverge")
  }
}
