import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { memoryApiPlugin } from "./server/memoryApiPlugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss(), memoryApiPlugin()],
});
