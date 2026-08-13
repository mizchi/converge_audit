///|
test "browser SHA-256 bridge matches the standard abc vector" {
  inspect(
    audit_browser_sha256("abc"),
    content="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  )
}

///|
test "browser Merkle bridge binds order and leaf count" {
  let root = audit_browser_merkle_root(["a", "b", "c"])
  inspect(root.length(), content="64")
  assert_not_eq(root, audit_browser_merkle_root(["b", "a", "c"]))
  assert_not_eq(root, audit_browser_merkle_root(["a", "b", "c", "c"]))
}

///|
test "browser Ed25519 bridge signs and verifies an RFC 8032 vector" {
  let seed = "9d61b19deffd5a60ba844af492ec2cc4" +
    "4449c5697b326919703bac031cae7f60"
  let public_key = audit_browser_ed25519_public_key(seed)
  inspect(
    public_key,
    content=(
      #|d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
    ),
  )
  let signature = audit_browser_ed25519_sign(seed, "")
  inspect(
    signature,
    content=(
      #|e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b
    ),
  )
  assert_true(audit_browser_ed25519_verify(public_key, "", signature))
  assert_false(audit_browser_ed25519_verify(public_key, "tampered", signature))
}

///|
test "browser Ed25519 bridge rejects malformed wire values" {
  assert_eq(audit_browser_ed25519_public_key("not-hex"), "")
  assert_eq(audit_browser_ed25519_sign("not-hex", "digest"), "")
  assert_false(audit_browser_ed25519_verify("not-hex", "digest", "not-hex"))
}

///|
test "browser and server share replay-witness manifest framing" {
  let left = audit_browser_replay_witness_session_manifest_statement(
    "game-manifest",
    "referee-key",
    ["alice", "bob"],
    ["alice-key", "bob-key"],
    0,
  )
  let reordered = audit_browser_replay_witness_session_manifest_statement(
    "game-manifest",
    "referee-key",
    ["bob", "alice"],
    ["bob-key", "alice-key"],
    0,
  )
  assert_true(left != "")
  assert_eq(left, reordered)
  assert_eq(
    audit_browser_replay_witness_session_manifest_statement(
      "game-manifest",
      "referee-key",
      ["alice"],
      [],
      0,
    ),
    "",
  )
}

///|
test "browser exposes both MoonBit-owned inventory origin statements" {
  let receipt_statement = audit_browser_inventory_origin_receipt_statement(
    "asset-1", "alice", "raid-token", 2, "loot-event", 3,
  )
  let receipt_digest = audit_browser_sha256(receipt_statement)
  let lineage_statement = audit_browser_inventory_origin_lineage_statement(
    receipt_digest,
  )
  assert_true(receipt_statement != "")
  assert_true(lineage_statement != "")
  assert_true(audit_browser_sha256(lineage_statement) != receipt_digest)
  assert_eq(
    audit_browser_inventory_origin_receipt_statement(
      "", "alice", "raid-token", 2, "loot-event", 3,
    ),
    "",
  )
  assert_eq(audit_browser_inventory_origin_lineage_statement(""), "")
}

///|
test "browser exposes the MoonBit-owned inventory lineage transition statement" {
  let statement = audit_browser_inventory_lineage_transition_statement(
    "asset-雪😀", "origin-digest", "alice-猫", "bob-犬", 2, "previous-event",
    "transfer-event", "previous-root",
  )
  assert_true(statement != "")
  assert_true(audit_browser_sha256(statement) != "")
  assert_eq(
    audit_browser_inventory_lineage_transition_statement(
      "", "origin-digest", "alice", "bob", 2, "previous", "source", "root",
    ),
    "",
  )
}

///|
test "browser exposes MoonBit-owned inventory record and AuthMap statements" {
  let record = audit_browser_inventory_record_statement(
    "asset-雪😀", "alice-猫", "raid-token", 2, "loot-event", 3, "origin-digest",
    1, "transfer-event", "lineage-root",
  )
  let leaf = audit_browser_authmap_node_statement(
    "asset-雪😀", record, "left-digest", "right-digest",
  )
  let leaf_digest = audit_browser_sha256(leaf)
  let root = audit_browser_authmap_root_statement(1, leaf_digest)
  let empty = audit_browser_authmap_empty_statement()
  let empty_digest = audit_browser_sha256(empty)
  let empty_root = audit_browser_authmap_root_statement(0, empty_digest)
  assert_true(record != "")
  assert_true(leaf != "")
  assert_true(root != "")
  assert_true(empty != "")
  assert_true(empty_root != "")
  assert_true(audit_browser_sha256(root) != leaf_digest)
  assert_eq(audit_browser_authmap_root_statement(-1, empty_digest), "")
}
