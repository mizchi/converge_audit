export interface DigestVerificationCheck {
  kind: string;
  check_index: number;
  canonical_statement: string;
  expected_digest: string;
}

export interface DigestVerificationPlan {
  hash_check_count: number;
  hash_checks: DigestVerificationCheck[];
}

export interface AsyncDigestVerificationBackend {
  hashString(value: string): Promise<string>;
}

export type VerifyDigestVerificationPlanResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason: "invalid_plan" | "digest_mismatch";
      checkIndex: number;
    };

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function digestVerificationCheckValid(
  check: DigestVerificationCheck | null | undefined,
  expectedIndex: number,
): check is DigestVerificationCheck {
  return typeof check === "object" && check !== null &&
    boundedText(check.kind, 256) &&
    check.check_index === expectedIndex &&
    boundedText(check.canonical_statement, 65_536) &&
    digestValid(check.expected_digest);
}

/** Execute only cryptographic work; MoonBit owns statement semantics. */
export async function verifyDigestVerificationPlan(
  plan: DigestVerificationPlan,
  backend: AsyncDigestVerificationBackend,
): Promise<VerifyDigestVerificationPlanResult> {
  if (
    typeof plan !== "object" || plan === null ||
    !Number.isSafeInteger(plan.hash_check_count) ||
    plan.hash_check_count <= 0 || plan.hash_check_count > 4096 ||
    !Array.isArray(plan.hash_checks) ||
    plan.hash_checks.length !== plan.hash_check_count
  ) {
    return { ok: false, reason: "invalid_plan", checkIndex: 0 };
  }
  for (let index = 0; index < plan.hash_checks.length; index++) {
    if (!digestVerificationCheckValid(plan.hash_checks[index], index)) {
      return { ok: false, reason: "invalid_plan", checkIndex: index };
    }
  }
  const actual = await Promise.all(
    plan.hash_checks.map((check) => backend.hashString(check.canonical_statement)),
  );
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== plan.hash_checks[index].expected_digest) {
      return { ok: false, reason: "digest_mismatch", checkIndex: index };
    }
  }
  return { ok: true, checkCount: actual.length };
}
