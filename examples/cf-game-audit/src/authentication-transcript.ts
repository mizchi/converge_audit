export interface DigestSignatureAuthenticationCheck {
  public_key: string;
  canonical_statement: string;
  digest: string;
  signature: string;
}

export interface AsyncDigestSignatureAuthenticationBackend {
  hashString(value: string): Promise<string>;
  verify(
    publicKey: string,
    digest: string,
    signature: string,
  ): Promise<boolean>;
}

export type VerifyDigestSignatureAuthenticationChecksResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason:
        | "invalid_transcript"
        | "digest_mismatch"
        | "signature_refused";
      checkIndex: number;
    };

export function digestSignatureAuthenticationCheckValid(
  check: DigestSignatureAuthenticationCheck | null | undefined,
): check is DigestSignatureAuthenticationCheck {
  return typeof check === "object" && check !== null &&
    /^[0-9a-f]{64}$/.test(check.public_key) &&
    typeof check.canonical_statement === "string" &&
    check.canonical_statement.length > 0 &&
    check.canonical_statement.length <= 65_536 &&
    /^[0-9a-f]{64}$/.test(check.digest) &&
    /^[0-9a-f]{128}$/.test(check.signature);
}

export async function verifyDigestSignatureAuthenticationChecks(
  checks: DigestSignatureAuthenticationCheck[],
  backend: AsyncDigestSignatureAuthenticationBackend,
): Promise<VerifyDigestSignatureAuthenticationChecksResult> {
  for (let index = 0; index < checks.length; index++) {
    if (!digestSignatureAuthenticationCheckValid(checks[index])) {
      return { ok: false, reason: "invalid_transcript", checkIndex: index };
    }
  }

  const cached = new Map<
    string,
    Promise<"verified" | "digest_mismatch" | "signature_refused">
  >();
  const results = checks.map((check) => {
    const cacheKey = JSON.stringify([
      check.public_key,
      check.canonical_statement,
      check.digest,
      check.signature,
    ]);
    let result = cached.get(cacheKey);
    if (!result) {
      result = verifyDigestSignatureAuthenticationCheck(check, backend);
      cached.set(cacheKey, result);
    }
    return result;
  });
  const resolved = await Promise.all(results);
  for (let index = 0; index < resolved.length; index++) {
    const result = resolved[index];
    if (result === "digest_mismatch" || result === "signature_refused") {
      return { ok: false, reason: result, checkIndex: index };
    }
  }
  return { ok: true, checkCount: checks.length };
}

async function verifyDigestSignatureAuthenticationCheck(
  check: DigestSignatureAuthenticationCheck,
  backend: AsyncDigestSignatureAuthenticationBackend,
): Promise<"verified" | "digest_mismatch" | "signature_refused"> {
  if (await backend.hashString(check.canonical_statement) !== check.digest) {
    return "digest_mismatch";
  }
  return await backend.verify(
      check.public_key,
      check.digest,
      check.signature,
    )
    ? "verified"
    : "signature_refused";
}
