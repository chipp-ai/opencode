export * as SessionRunnerFallback from "./fallback"

import { LLMError, type ProviderErrorEvent } from "@opencode-ai/llm"
import { ModelV2 } from "../../model"

/**
 * Decides whether a failed provider turn should move to the next fallback model.
 *
 * `RequestExecutor` has already spent its retry budget on `LLMError.retryable` failures (429/5xx/529) by the
 * time one reaches the runner, so those are the retry-exhausted case. Quota, transport, and model-not-found
 * failures are not worth retrying against the same model but are exactly what a different model can fix.
 * Auth, content-policy, context-overflow, and malformed-request failures would fail the same way elsewhere.
 */
export function shouldFallback(failure: unknown) {
  if (failure instanceof LLMError) {
    if (failure.retryable) return true
    const reason = failure.reason
    if (reason._tag === "QuotaExceeded" || reason._tag === "Transport") return true
    return (
      reason._tag === "InvalidRequest" &&
      reason.classification !== "context-overflow" &&
      reason.http?.response?.status === 404
    )
  }
  if (!isProviderError(failure)) return false
  return failure.retryable === true && failure.classification !== "context-overflow"
}

/** Returns untried fallback refs in configured order, excluding the model that just failed. */
export function candidates(
  current: ModelV2.Ref,
  fallback: ReadonlyArray<ModelV2.Ref>,
  tried: ReadonlyArray<ModelV2.Ref>,
) {
  return fallback.filter((ref) => !same(ref, current) && !tried.some((item) => same(item, ref)))
}

export function same(left: ModelV2.Ref, right: ModelV2.Ref) {
  return left.providerID === right.providerID && left.id === right.id
}

function isProviderError(failure: unknown): failure is ProviderErrorEvent {
  return typeof failure === "object" && failure !== null && "type" in failure && failure.type === "provider-error"
}
