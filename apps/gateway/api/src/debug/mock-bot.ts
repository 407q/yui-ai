process.env.BOT_MODE = "mock";
process.env.BOT_ENABLE_MOCK_MODE = "true";
await import("../bot.js");
