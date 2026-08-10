import type {
  EvidenceCaseResolutionAuthorizationVerifier,
  EvidenceCaseResolutionNotice,
} from "../../player-local-runtime/evidence-case-resolution-relay";
import {
  decodeEvidenceCaseDismissalCertificate,
  verifyEvidenceCaseDismissalCertificate,
} from "./evidence-case-dismissal-certificate";
import {
  decodeLineageDecisionCertificate,
  verifyLineageDecisionCertificate,
  type LineageDecisionArbiterRoster,
  type LineageDecisionDigestAdapter,
  type LineageDecisionVerifierRegistry,
} from "./lineage-decision-certificate";

export interface ReferenceGameEvidenceResolutionAuthorizationOptions {
  roster: LineageDecisionArbiterRoster;
  verifiers: LineageDecisionVerifierRegistry;
  digest: LineageDecisionDigestAdapter;
  maxClockSkewMs: number;
}

export function createReferenceGameEvidenceResolutionAuthorizationVerifier(
  options: ReferenceGameEvidenceResolutionAuthorizationOptions,
): EvidenceCaseResolutionAuthorizationVerifier {
  return Object.freeze({
    verify(notice: EvidenceCaseResolutionNotice): boolean {
      const authorization = recordValue(notice.authorization);
      if (!authorization || !("certificate" in authorization)) return false;
      if (authorization.kind === "dismissal") {
        if (notice.resolution.decision !== "dismissed") return false;
        const certificate = decodeEvidenceCaseDismissalCertificate(
          authorization.certificate,
        );
        if (!certificate) return false;
        const verified = verifyEvidenceCaseDismissalCertificate(certificate, {
          expectedScope: notice.scope,
          expectedUnit: notice.unit,
          nowMs: notice.acceptedAtMs,
          maxClockSkewMs: options.maxClockSkewMs,
          roster: options.roster,
          verifiers: options.verifiers,
          digest: options.digest,
        });
        return verified.ok && verified.dismissalId ===
            notice.resolution.resolution_digest &&
          certificate.statement.evidenceCaseId === notice.caseId;
      }
      if (authorization.kind === "lineage_decision") {
        if (notice.resolution.decision !== "upheld") return false;
        const certificate = decodeLineageDecisionCertificate(
          authorization.certificate,
        );
        if (!certificate || certificate.statement.version !== 2) return false;
        const verified = verifyLineageDecisionCertificate(certificate, {
          expectedScope: notice.scope,
          expectedUnit: notice.unit,
          nowMs: notice.acceptedAtMs,
          maxClockSkewMs: options.maxClockSkewMs,
          roster: options.roster,
          verifiers: options.verifiers,
          digest: options.digest,
        });
        return verified.ok && verified.decisionId ===
            notice.resolution.resolution_digest &&
          certificate.statement.evidenceCaseId === notice.caseId;
      }
      return false;
    },
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
