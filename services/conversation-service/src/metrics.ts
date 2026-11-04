import { Counter, createMetrics, type Metrics } from "@messenger/shared";

// conversation-service's metrics: the shared HTTP and runtime metrics, plus one counter.
export interface ConversationMetrics extends Metrics {
  compensations: Counter;
}

export function createConversationMetrics(): ConversationMetrics {
  const metrics = createMetrics("conversation-service");
  return {
    ...metrics,
    // Should stay at 0. Anything else means message-service failed during a create.
    compensations: new Counter({
      name: "messenger_conversation_compensations_total",
      help: "Conversations deleted from MongoDB because registering them with message-service failed.",
      registers: [metrics.registry],
    }),
  };
}
