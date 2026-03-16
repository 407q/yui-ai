import "dotenv/config";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN is required.");
}

if (!clientId) {
  throw new Error("DISCORD_CLIENT_ID is required.");
}

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("このスレッドのセッション状態を表示します"),
  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("このスレッドの実行中タスクをキャンセルします"),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("このスレッドのセッションを終了します"),
  new SlashCommandBuilder()
    .setName("exit")
    .setDescription("全セッションを終了し、モックシステム全体を終了します"),
  new SlashCommandBuilder()
    .setName("reboot")
    .setDescription("全セッションを終了し、モックシステム全体を再起動します"),
  new SlashCommandBuilder()
    .setName("list")
    .setDescription("自分のセッション一覧を表示します"),
].map((builder) => builder.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log(`[mockup] Registered commands for guild ${guildId}.`);
} else {
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[mockup] Registered global commands.");
}
