// Runs once, when the mongo volume is first created (mongosh, as the root user).
// One login for conversation-service, with access to its database and its test database.
db.getSiblingDB("messenger").createUser({
  user: "conversation_svc",
  pwd: process.env.CONVERSATION_DB_PASSWORD,
  roles: [
    { role: "readWrite", db: "messenger" },
    { role: "readWrite", db: "messenger_test" },
  ],
});
