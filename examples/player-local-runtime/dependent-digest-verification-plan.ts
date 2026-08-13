export interface DependentDigestVerificationCheck {
  kind: string;
  check_index: number;
  statement_segments: string[];
  dependency_check_indices: number[];
  expected_digest: string;
}

export interface DependentDigestVerificationPlan {
  hash_check_count: number;
  hash_checks: DependentDigestVerificationCheck[];
}

export interface AsyncDependentDigestVerificationBackend {
  hashString(value: string): Promise<string>;
}

export type VerifyDependentDigestVerificationPlanResult =
  | { ok: true; checkCount: number }
  | {
      ok: false;
      reason: "invalid_plan" | "digest_mismatch";
      checkIndex: number;
    };

function boundedText(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return typeof value === "string" &&
    (allowEmpty || value.length > 0) && value.length <= maxLength;
}

function digestValid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function checkValid(
  check: DependentDigestVerificationCheck | null | undefined,
  expectedIndex: number,
): check is DependentDigestVerificationCheck {
  if (
    typeof check !== "object" || check === null ||
    !boundedText(check.kind, 256) ||
    check.check_index !== expectedIndex ||
    !Array.isArray(check.statement_segments) ||
    !Array.isArray(check.dependency_check_indices) ||
    check.statement_segments.length !==
      check.dependency_check_indices.length + 1 ||
    check.statement_segments.length > 17 ||
    !digestValid(check.expected_digest)
  ) {
    return false;
  }
  let statementLength = 0;
  for (const segment of check.statement_segments) {
    if (!boundedText(segment, 65_536, true)) return false;
    statementLength += segment.length;
  }
  if (statementLength <= 0 || statementLength > 65_536) return false;
  const dependencies = new Set<number>();
  for (const dependency of check.dependency_check_indices) {
    if (
      !Number.isSafeInteger(dependency) || dependency < 0 ||
      dependency >= expectedIndex || dependencies.has(dependency)
    ) {
      return false;
    }
    dependencies.add(dependency);
  }
  return true;
}

/** Execute a backward-only digest DAG without interpreting its domain framing. */
export async function verifyDependentDigestVerificationPlan(
  plan: DependentDigestVerificationPlan,
  backend: AsyncDependentDigestVerificationBackend,
): Promise<VerifyDependentDigestVerificationPlanResult> {
  if (
    typeof plan !== "object" || plan === null ||
    !Number.isSafeInteger(plan.hash_check_count) ||
    plan.hash_check_count <= 0 || plan.hash_check_count > 4_224 ||
    !Array.isArray(plan.hash_checks) ||
    plan.hash_checks.length !== plan.hash_check_count
  ) {
    return { ok: false, reason: "invalid_plan", checkIndex: 0 };
  }
  const computed: Promise<string>[] = [];
  let literalBytes = 0;
  for (let index = 0; index < plan.hash_checks.length; index++) {
    const check = plan.hash_checks[index];
    if (!checkValid(check, index)) {
      return { ok: false, reason: "invalid_plan", checkIndex: index };
    }
    literalBytes += check.statement_segments.reduce(
      (total, segment) => total + segment.length,
      0,
    );
    if (literalBytes > 8_388_608) {
      return { ok: false, reason: "invalid_plan", checkIndex: index };
    }
    const dependencies = check.dependency_check_indices.map(
      (dependency) => computed[dependency],
    );
    computed.push(Promise.all(dependencies).then((digests) => {
      let statement = check.statement_segments[0];
      for (let dependencyIndex = 0; dependencyIndex < digests.length; dependencyIndex++) {
        statement += digests[dependencyIndex] +
          check.statement_segments[dependencyIndex + 1];
      }
      return backend.hashString(statement);
    }));
  }
  const actual = await Promise.all(computed);
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== plan.hash_checks[index].expected_digest) {
      return { ok: false, reason: "digest_mismatch", checkIndex: index };
    }
  }
  return { ok: true, checkCount: actual.length };
}
