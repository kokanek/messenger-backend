import { Counter, createMetrics, Gauge, type Metrics } from "@messenger/shared";

// message-service's metrics: the shared HTTP and runtime metrics, plus two Messenger ones.
export interface MessageMetrics extends Metrics {
  messagesSent: Counter;
  websocketConnections: Gauge;
}

export function createMessageMetrics(): MessageMetrics {
  const metrics = createMetrics("message-service");
  return {
    ...metrics,
    messagesSent: new Counter({
      name: "messenger_messages_sent_total",
      help: "Messages stored; a retried send with the same clientMessageId is not counted again.",
      registers: [metrics.registry],
    }),
    // A gauge, not a counter: it goes down when a socket closes.
    websocketConnections: new Gauge({
      name: "messenger_websocket_connections",
      help: "Open WebSocket connections that have sent a valid auth frame.",
      registers: [metrics.registry],
    }),
  };
}
