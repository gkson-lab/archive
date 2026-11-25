// `npm start`: run agentdeck as a local web app in your browser.
import { fixPath } from "./cli.js";
import { start } from "./server.js";

fixPath();
const port = await start();
console.log(`\n  agentdeck is running → http://localhost:${port}\n`);
