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
    #|        "verifiedAncestors": { "#set": [{ "#bigint": "0" }] },
    #|        "retainedAnchorVersion": { "#bigint": "0" },
    #|        "lineageProofCount": { "#bigint": "0" },
    #|        "lineageClean": true,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true,
    #|        "lastLineageProofAuthenticated": true,
    #|        "lastLineageParentMatches": true,
    #|        "lastLineageTerminalMatches": true
    #|      }
    #|    },
    #|    {
    #|      "#meta": { "index": 1 },
    #|      "mbt::actionTaken": "transferSome",
    #|      "mbt::nondetPicks": {
    #|        "from": { "tag": "O1", "value": { "#tup": [] } },
    #|        "recipient": { "tag": "O2", "value": { "#tup": [] } },
    #|        "previousVersion": { "#bigint": "0" },
    #|        "nextVersion": { "#bigint": "1" },
    #|        "senderAuthenticated": true,
    #|        "recipientAuthenticated": true
    #|      },
    #|      "state": {
    #|        "owner": { "tag": "O2", "value": { "#tup": [] } },
    #|        "ownerVersion": { "#bigint": "1" },
    #|        "transferCount": { "#bigint": "1" },
    #|        "listingStatus": { "tag": "NeverListed", "value": { "#tup": [] } },
    #|        "listingOwner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "listingVersion": { "#bigint": "-1" },
    #|        "listingNonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "canceledListingNonces": { "#set": [] },
    #|        "revokedAncestors": { "#set": [] },
    #|        "verifiedAncestors": { "#set": [{ "#bigint": "0" }] },
    #|        "retainedAnchorVersion": { "#bigint": "0" },
    #|        "lineageProofCount": { "#bigint": "0" },
    #|        "lineageClean": true,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true,
    #|        "lastLineageProofAuthenticated": true,
    #|        "lastLineageParentMatches": true,
    #|        "lastLineageTerminalMatches": true
    #|      }
    #|    },
    #|    {
    #|      "#meta": { "index": 2 },
    #|      "mbt::actionTaken": "registerLineageSome",
    #|      "mbt::nondetPicks": {
    #|        "startVersion": { "#bigint": "0" },
    #|        "endVersion": { "#bigint": "1" },
    #|        "proofAuthenticated": true,
    #|        "parentMatches": true,
    #|        "terminalMatches": true
    #|      },
    #|      "state": {
    #|        "owner": { "tag": "O2", "value": { "#tup": [] } },
    #|        "ownerVersion": { "#bigint": "1" },
    #|        "transferCount": { "#bigint": "1" },
    #|        "listingStatus": { "tag": "NeverListed", "value": { "#tup": [] } },
    #|        "listingOwner": { "tag": "O1", "value": { "#tup": [] } },
    #|        "listingVersion": { "#bigint": "-1" },
    #|        "listingNonce": { "tag": "N1", "value": { "#tup": [] } },
    #|        "canceledListingNonces": { "#set": [] },
    #|        "revokedAncestors": { "#set": [] },
    #|        "verifiedAncestors": {
    #|          "#set": [{ "#bigint": "0" }, { "#bigint": "1" }]
    #|        },
    #|        "retainedAnchorVersion": { "#bigint": "1" },
    #|        "lineageProofCount": { "#bigint": "1" },
    #|        "lineageClean": true,
    #|        "lastTransferLineageClean": true,
    #|        "lastSenderAuthenticated": true,
    #|        "lastRecipientAuthenticated": true,
    #|        "lastLineageProofAuthenticated": true,
    #|        "lastLineageParentMatches": true,
    #|        "lastLineageTerminalMatches": true
    #|      }
    #|    }
    #|  ]
    #|}
  )
}

///|
test "Quint asset lineage registration trace matches the MoonBit audit policy" {
  let trace = @quint_connect.parse_itf_with_config(revocation_trace_fixture(), {
    state_path: ["state"],
    nondet_path: [],
  }).unwrap()
  let summary = replay_asset_ownership(trace, new_asset_driver()).unwrap()
  assert_eq(summary.states_checked, 3)
}

///|
test "Quint Connect detects an implementation that skips lineage retention" {
  let trace = @quint_connect.parse_itf_with_config(revocation_trace_fixture(), {
    state_path: ["state"],
    nondet_path: [],
  }).unwrap()
  match
    replay_asset_ownership(
      trace,
      new_asset_driver(broken_lineage_registration=true),
    ) {
    Err(StateDiverged(2, "registerLineageSome", expected, actual)) => {
      assert_true(expected.contains("retained_anchor_version: 1"))
      assert_true(actual.contains("retained_anchor_version: 0"))
    }
    _ => fail("broken lineage retention must diverge")
  }
}
