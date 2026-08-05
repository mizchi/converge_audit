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
