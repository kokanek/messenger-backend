import type { InternalClient, Summary } from "@messenger/shared";

export interface RegisterConversation {
  id: string;
  type: "direct" | "group";
  memberIds: string[];
  createdAt: string;
}

// conversation-service's two calls to message-service (backend spec, section 9).
// Behind an interface so the tests can use a fake message-service.
export interface MessageService {
  registerConversation(input: RegisterConversation, requestId?: string): Promise<void>;
  summaries(userId: string, conversationIds: string[], requestId?: string): Promise<Summary[]>;
}

export function httpMessageService(client: InternalClient): MessageService {
  return {
    async registerConversation(input, requestId) {
      const res = await client.post<{ created: boolean }>("/internal/conversations", input, requestId);
      if (res.status !== 200) throw new Error(`registering a conversation returned HTTP ${res.status}`);
    },
    async summaries(userId, conversationIds, requestId) {
      const res = await client.post<{ items: Summary[] }>(
        "/internal/summaries",
        { userId, conversationIds },
        requestId,
      );
      if (res.status !== 200) throw new Error(`summaries returned HTTP ${res.status}`);
      return res.body.items;
    },
  };
}
