import { AppError, requestIdOf, requireAuth, type ConversationSummary } from "@messenger/shared";
import { Router } from "express";
import { MongoServerError } from "mongodb";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { conversations, dmKeyFor, toSummary, type ConversationDoc } from "../store.js";

const createBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("direct"),
    memberIds: z.array(z.uuid()).min(1).max(2),
  }),
  z.object({
    type: z.literal("group"),
    name: z.string().trim().min(1).max(100),
    memberIds: z.array(z.uuid()).min(1).max(256),
  }),
]);

export function conversationRoutes({ db, config, messageService, logger, metrics }: AppDeps): Router {
  const router = Router();
  const collection = conversations(db);
  router.use("/api/conversations", requireAuth(config.JWT_SECRET));

  // The conversation list: names and members from MongoDB, last message and unread
  // count from message-service. Two databases, so the join happens here in code
  // (backend spec, section 10.7).
  router.get("/api/conversations", async (req, res) => {
    const userId = req.auth!.userId;
    const docs = await collection
      .find({ memberIds: userId }, { projection: { _id: 1, type: 1, name: 1, memberIds: 1, createdAt: 1 } })
      .toArray();
    if (docs.length === 0) {
      res.json([]);
      return;
    }

    const byId = new Map(docs.map((doc) => [doc._id, doc as ConversationDoc]));
    const items = await messageService.summaries(userId, [...byId.keys()], requestIdOf(req));
    if (items.length < docs.length) {
      // Only happens if registering with message-service failed and so did the cleanup.
      const missing = [...byId.keys()].filter((id) => !items.some((s) => s.conversationId === id));
      logger.warn({ missing }, "conversations missing from message-service");
    }
    // message-service returns them newest activity first; keep that order.
    const list: ConversationSummary[] = items.map((summary) => toSummary(byId.get(summary.conversationId)!, summary));
    res.json(list);
  });

  router.post("/api/conversations", async (req, res) => {
    const body = createBody.parse(req.body);
    const me = req.auth!.userId;
    const others = [...new Set(body.memberIds)].filter((id) => id !== me);
    const requestId = requestIdOf(req);

    if (body.type === "direct" && others.length !== 1) {
      throw new AppError("VALIDATION_FAILED", "A direct conversation needs exactly one other user");
    }
    if (body.type === "group" && (others.length < 1 || others.length > 255)) {
      throw new AppError("VALIDATION_FAILED", "A group needs 1 to 255 other members");
    }
    // Member ids aren't checked against auth-service: the app only offers real users,
    // and a made-up id is harmless because nobody can log in as it.

    const doc: ConversationDoc = {
      _id: uuidv7(),
      type: body.type,
      name: body.type === "group" ? body.name : null,
      createdBy: me,
      createdAt: new Date(),
      memberIds: [me, ...others],
      dmKey: body.type === "direct" ? dmKeyFor(me, others[0]!) : null,
    };

    // Direct: at most one per pair. If it exists, return it with 200.
    if (doc.dmKey) {
      const existing = await collection.findOne({ dmKey: doc.dmKey });
      if (existing) return void res.json(await existingDirect(existing, me, requestId));
    }

    try {
      await collection.insertOne(doc);
    } catch (err) {
      // The unique dmKey index caught a concurrent create of the same direct conversation.
      if (err instanceof MongoServerError && err.code === 11000 && doc.dmKey) {
        const existing = await collection.findOne({ dmKey: doc.dmKey });
        if (existing) return void res.json(await existingDirect(existing, me, requestId));
      }
      throw err;
    }

    // Tell message-service the conversation exists and who is in it. If that fails, undo
    // the MongoDB insert (compensation), so the conversation never half-exists.
    try {
      await messageService.registerConversation(
        { id: doc._id, type: doc.type, memberIds: doc.memberIds, createdAt: doc.createdAt.toISOString() },
        requestId,
      );
    } catch (err) {
      await collection.deleteOne({ _id: doc._id });
      metrics?.compensations.inc();
      logger.warn(
        { conversationId: doc._id, requestId },
        "registering with message-service failed; conversation removed",
      );
      throw err instanceof AppError ? err : new AppError("DEPENDENCY_UNAVAILABLE", "Couldn't create the conversation");
    }

    res.status(201).json(toSummary(doc));
  });

  // Registering again is harmless (message-service skips what exists), and it repairs a
  // direct conversation whose first registration failed.
  async function existingDirect(doc: ConversationDoc, me: string, requestId: string): Promise<ConversationSummary> {
    await messageService.registerConversation(
      { id: doc._id, type: doc.type, memberIds: doc.memberIds, createdAt: doc.createdAt.toISOString() },
      requestId,
    );
    const [summary] = await messageService.summaries(me, [doc._id], requestId);
    return toSummary(doc, summary);
  }

  return router;
}
